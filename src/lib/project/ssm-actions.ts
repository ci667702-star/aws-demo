/**
 * Systems Manager Parameter Store 콘솔 동작 (가상).
 * String·StringList는 입력한 설정 값을 그대로 보관한다. SecureString은 값을 입력받지 않고, 화면에는 버전으로 계산한 연습용 가상 값을 보여 준다.
 */
import { createId } from "@/lib/engine/ids";
import type { Project, Services, SsmParameter } from "@/lib/engine/resource-models";
import { validateParameterName, validateParameterValue } from "@/lib/engine/ssm-engine";
import { awsFail, type ActionResult } from "./console-actions";
import { touch } from "./mutations";

const ok = (project: Project, notes: string[] = [], createdId?: string): ActionResult => ({ ok: true, project, notes, createdId });

function withSsm(project: Project, update: (ssm: Services["ssm"]) => Services["ssm"]): Project {
  return touch({ ...project, services: { ...project.services, ssm: update(project.services.ssm) } });
}

/** 이름이 비밀 값을 뜻하는 것처럼 보이는지 (암호·토큰·키) */
const SECRET_LIKE_NAME = /(password|passwd|secret|token|private[-_]?key|access[-_]?key|api[-_]?key|credential)/i;
/** 실제 자격 증명처럼 보이는 값 (AWS 액세스 키 ID, PEM 개인 키) */
const SECRET_LIKE_VALUE = /\b(AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export interface PutParameterInput {
  name: string;
  description: string;
  type: SsmParameter["type"];
  tier: SsmParameter["tier"];
  /** String·StringList의 값. SecureString은 무시한다 (입력받지 않음) */
  value: string;
  /** 같은 이름이 있으면 새 버전으로 덮어쓴다 */
  overwrite: boolean;
}

/** PutParameter: 새 파라미터를 만들거나(버전 1), overwrite면 새 버전으로 바꾼다 */
export function putParameter(project: Project, input: PutParameterInput, now = Date.now()): ActionResult {
  const name = input.name.trim();
  const invalid = validateParameterName(name);
  if (invalid) return awsFail("ValidationException", invalid);
  if (input.description.length > 1024) return awsFail("ValidationException", "설명은 1,024자 이하여야 합니다.");
  const existing = project.services.ssm.parameters.find((p) => p.name === name);
  if (existing && !input.overwrite) {
    return awsFail("ParameterAlreadyExists", "The parameter already exists. To overwrite this value, set the overwrite option in the request to true.", "같은 이름의 파라미터가 있습니다. 값을 바꾸려면 그 파라미터를 편집하세요 (새 버전이 만들어집니다).");
  }
  if (existing && existing.type !== input.type) return awsFail("ValidationException", "이 시뮬레이터에서는 만든 뒤 파라미터 유형을 바꿀 수 없습니다.", "유형을 바꾸려면 파라미터를 삭제하고 다시 만드세요.");
  if (existing && existing.tier === "Advanced" && input.tier === "Standard") {
    return awsFail("ValidationException", "This parameter uses the advanced-parameter tier. You can't downgrade a parameter from the advanced-parameter tier to the standard-parameter tier.", "고급(Advanced) 파라미터는 표준(Standard)으로 되돌릴 수 없습니다. 삭제하고 다시 만들어야 합니다.");
  }
  const notes: string[] = [];
  let value: string | null = null;
  if (input.type === "SecureString") {
    notes.push("SecureString 값은 입력받지 않았습니다. 연습용 가상 값(PGSIM-…)이 만들어졌으며 실제 비밀 값이 아닙니다.");
  } else {
    value = input.value;
    const bad = validateParameterValue(input.type, input.tier, value);
    if (bad) return awsFail("ValidationException", bad);
    if (SECRET_LIKE_VALUE.test(value) || SECRET_LIKE_NAME.test(name)) {
      return awsFail(
        "SimulatorSafetyRule",
        "비밀 값(암호·토큰·키)은 String으로 저장하지 마세요.",
        "이 시뮬레이터의 안전 규칙입니다: 이름이나 값이 비밀 값으로 보이면 평문(String)으로 받지 않습니다. 유형을 SecureString으로 고르세요 — 값은 입력받지 않고 가상 값으로 대신합니다. 실제 AWS에서도 비밀 값은 SecureString이나 Secrets Manager에 둡니다.",
      );
    }
  }
  const at = new Date(now).toISOString();
  if (existing) {
    const updated: SsmParameter = {
      ...existing,
      description: input.description.trim(),
      tier: input.tier,
      value,
      version: existing.version + 1,
      history: [{ version: existing.version, value: existing.value, modifiedAt: existing.updatedAt }, ...existing.history].slice(0, 20),
      updatedAt: at,
    };
    return ok(withSsm(project, (ssm) => ({ parameters: ssm.parameters.map((p) => (p.id === existing.id ? updated : p)) })), [...notes, `버전 ${updated.version}이(가) 되었습니다. 이전 버전은 기록에 남습니다.`]);
  }
  const param: SsmParameter = { id: createId("param"), name, description: input.description.trim(), type: input.type, tier: input.tier, value, version: 1, history: [], createdAt: at, updatedAt: at };
  if (input.tier === "Advanced") notes.push("고급(Advanced) 파라미터는 개수만큼 요금이 붙습니다 (표준은 무료). 4KB를 넘는 값이나 파라미터 정책이 필요할 때만 쓰세요.");
  return ok(withSsm(project, (ssm) => ({ parameters: [...ssm.parameters, param] })), notes, param.id);
}

export function deleteParameter(project: Project, parameterId: string): ActionResult {
  const param = project.services.ssm.parameters.find((p) => p.id === parameterId);
  if (!param) return awsFail("ParameterNotFound", "파라미터를 찾을 수 없습니다.");
  const users = project.resources.filter((r) => r.type === "lambda" && r.config.codeTemplate === "ssm-get" && r.config.templateTarget.trim() === param.name);
  const notes = users.length ? [`이 파라미터를 읽는 함수가 있습니다: ${users.map((r) => r.name || r.id).join(", ")}. 삭제하면 그 함수가 ParameterNotFound로 실패합니다.`] : [];
  return ok(withSsm(project, (ssm) => ({ parameters: ssm.parameters.filter((p) => p.id !== parameterId) })), notes);
}
