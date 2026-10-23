"use client";

/**
 * 첫 화면: 샌드박스(가상 계정) 목록.
 * 앱이 미리 만들어 두는 프로젝트는 없다. 사용자가 빈 샌드박스를 만들고 콘솔에서 직접 구성한다.
 */
import { Cloud, Moon, Sun, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DISCLAIMER } from "@/components/app/brand";
import { ClientGate } from "@/components/app/client-gate";
import { ImportDialog } from "@/components/app/import-dialog";
import { Alert } from "@/components/console/ui/alert";
import { Button, ButtonDropdown } from "@/components/console/ui/button";
import { FormField, TextInput } from "@/components/console/ui/form";
import { Container, ContainerHeader, EmptyState, ExpandableSection, PageHeader, SpaceBetween } from "@/components/console/ui/layout";
import { DeleteModal, Modal } from "@/components/console/ui/overlay";
import { ResourceTable } from "@/components/console/ui/table";
import { Badge } from "@/components/console/ui/status";
import type { Project } from "@/lib/engine/resource-models";
import { LABS } from "@/lib/labs/labs";
import { SAMPLES } from "@/lib/project/samples";
import { exportFileName, exportProjectJson } from "@/lib/project/serialization";
import { useProjectStore } from "@/lib/store/project-store";
import { downloadTextFile } from "@/lib/ui/download";
import { formatDateTime, formatRelativeTime } from "@/lib/ui/format";

export function Dashboard() {
  return (
    <div className="flex min-h-dvh flex-col bg-aws-page text-aws-text">
      <SiteHeader />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6">
        <ClientGate>
          <DashboardContent />
        </ClientGate>
      </main>
      <footer className="border-t border-aws-border px-4 py-4 text-center text-xs text-aws-text-2">{DISCLAIMER}</footer>
    </div>
  );
}

function SiteHeader() {
  const { theme, setTheme } = useTheme();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon;
  return (
    <header className="sticky top-0 z-30 flex h-11 items-center gap-3 bg-aws-nav px-3 text-aws-nav-fg">
      <Link href="/" className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-aws-nav-hover">
        <span className="inline-flex size-6 items-center justify-center rounded bg-gradient-to-br from-sky-400 to-indigo-500 text-white">
          <Cloud className="size-3.5" aria-hidden />
        </span>
        <span className="flex flex-col leading-none">
          <span className="text-[13px] font-bold">AWS Playground</span>
          <span className="text-[10px] text-aws-nav-muted">비공식 학습용 · 가상 환경</span>
        </span>
      </Link>
      <nav className="ml-auto flex items-center gap-1" aria-label="사이트 메뉴">
        <Link href="/about" className="rounded-md px-2 py-1 text-sm hover:bg-aws-nav-hover">
          지원 범위
        </Link>
        <button type="button" onClick={() => setTheme(next)} className="rounded-md p-1.5 hover:bg-aws-nav-hover" aria-label={`화면 테마 바꾸기 (현재: ${theme ?? "system"})`}>
          <Icon className="size-4" aria-hidden />
        </button>
      </nav>
    </header>
  );
}

function stats(p: Project) {
  return {
    resources: p.resources.length,
    vpcs: p.resources.filter((r) => r.type === "vpc").length,
    running: p.resources.filter((r) => r.type === "ec2" && r.config.state === "running").length,
  };
}

function DashboardContent() {
  const router = useRouter();
  const projectsMap = useProjectStore((s) => s.projects);
  const loadErrors = useProjectStore((s) => s.loadErrors);
  const saveStatus = useProjectStore((s) => s.saveStatus);
  const saveError = useProjectStore((s) => s.saveError);
  const dismissLoadErrors = useProjectStore((s) => s.dismissLoadErrors);
  const projects = useMemo(() => Object.values(projectsMap).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [projectsMap]);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const current = projects.find((p) => p.id === selected[0]);

  const open = (id: string, hash = "#/") => router.push(`/console/${id}${hash}`);

  const onAction = (action: string, p: Project | undefined) => {
    if (!p) return;
    const store = useProjectStore.getState();
    if (action === "open") open(p.id);
    if (action === "rename") setRenaming(p);
    if (action === "duplicate") {
      const id = store.duplicateProject(p.id);
      if (id) setSelected([id]);
    }
    if (action === "export") downloadTextFile(exportFileName(p), exportProjectJson(p));
    if (action === "delete") setDeleting(p);
  };

  return (
    <SpaceBetween>
      {loadErrors.length > 0 && (
        <Alert type="warning" header="일부 저장 데이터를 불러오지 못했습니다" onDismiss={dismissLoadErrors}>
          <ul className="list-disc pl-5">
            {loadErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      {saveStatus === "error" && <Alert type="error" header="저장 실패">{saveError}</Alert>}
      {saveStatus === "unavailable" && <Alert type="warning">브라우저 저장소를 사용할 수 없어 새로고침하면 작업 내용이 사라집니다. 필요하면 JSON으로 내보내세요.</Alert>}

      <PageHeader
        title="AWS Playground"
        description="실제 AWS 계정이나 요금 없이, AWS 콘솔과 비슷한 화면에서 VPC·EC2·ALB·RDS를 직접 만들고 통신을 분석해 보는 학습용 시뮬레이터입니다."
      />
      <Alert type="info" header="비공식 학습용 시뮬레이터">
        Amazon Web Services와 제휴하지 않은 독립 프로젝트입니다. 실제 AWS 계정·액세스 키·리소스를 사용하지 않으며, 모든 리소스와 통신 결과는 이 브라우저 안에서 계산되는 가상 결과입니다.
      </Alert>

      <ResourceTable<Project>
        ariaLabel="샌드박스 목록"
        items={projects}
        trackBy={(p) => p.id}
        selectionType="single"
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(p) => p.name}
        header={
          <PageHeader
            title="샌드박스"
            counter={`(${projects.length})`}
            description="샌드박스는 서로 독립된 가상 AWS 환경입니다. 새 샌드박스는 비어 있으며, VPC부터 직접 구성합니다."
            actions={
              <>
                <ButtonDropdown
                  label="작업"
                  disabled={!current}
                  items={[
                    { id: "open", text: "콘솔 열기" },
                    { id: "rename", text: "이름 변경" },
                    { id: "duplicate", text: "복제" },
                    { id: "export", text: "JSON으로 내보내기" },
                    { id: "delete", text: "삭제", danger: true },
                  ]}
                  onItemClick={(a) => onAction(a, current)}
                />
                <Button onClick={() => setImporting(true)}>가져오기</Button>
                <Button variant="primary" onClick={() => setCreating(true)}>
                  샌드박스 생성
                </Button>
              </>
            }
          />
        }
        empty={
          <EmptyState
            title="샌드박스 없음"
            description="빈 샌드박스를 만들어 AWS 콘솔처럼 리소스를 하나씩 직접 만들어 보세요."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                샌드박스 생성
              </Button>
            }
          />
        }
        columns={[
          {
            id: "name",
            header: "이름",
            cell: (p) => (
              <a href={`/console/${p.id}#/`} className="font-bold text-aws-link hover:underline" data-testid="sandbox-link">
                {p.name}
              </a>
            ),
            sortValue: (p) => p.name,
            filterValue: (p) => `${p.name} ${p.description}`,
          },
          { id: "lab", header: "실습", cell: (p) => (p.labId ? <Badge color="blue">{LABS.find((l) => l.id === p.labId)?.title ?? p.labId}</Badge> : "–") },
          { id: "resources", header: "리소스", cell: (p) => `${stats(p).resources}개`, sortValue: (p) => stats(p).resources },
          { id: "vpcs", header: "VPC", cell: (p) => stats(p).vpcs },
          { id: "running", header: "실행 중인 인스턴스", cell: (p) => stats(p).running },
          { id: "updated", header: "마지막 수정", cell: (p) => <span title={formatDateTime(p.updatedAt)}>{formatRelativeTime(p.updatedAt)}</span>, sortValue: (p) => p.updatedAt },
          { id: "created", header: "생성일", cell: (p) => formatDateTime(p.createdAt), sortValue: (p) => p.createdAt },
        ]}
      />

      <Container header={<ContainerHeader title="실습 가이드" description="실습을 시작하면 빈 샌드박스가 만들어지고, 오른쪽 패널에 단계별 목표가 표시됩니다. 완료 여부는 실제 설정과 분석 결과로 자동 판정합니다." />}>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LABS.map((lab) => (
            <li key={lab.id} className="flex flex-col gap-2 rounded-xl border border-aws-border p-4" data-testid="lab-card">
              <div className="flex items-start justify-between gap-2">
                <p className="font-bold">
                  {lab.order}. {lab.title}
                </p>
                <Badge color="blue">{lab.level}</Badge>
              </div>
              <p className="flex-1 text-[13px] text-aws-text-2">{lab.summary}</p>
              {lab.id === "lab-5-security" && <p className="text-xs text-aws-warning">문제를 찾아 고치는 실습이라 잘못된 구성이 미리 만들어집니다.</p>}
              <div>
                <Button
                  onClick={() => {
                    const id = useProjectStore.getState().startLab(lab.id);
                    if (id) open(id, "#/?tools=labs");
                  }}
                >
                  실습 시작
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Container>

      <ExpandableSection variant="container" header="완성된 예시 아키텍처 살펴보기">
        <SpaceBetween size="m">
          <p className="text-sm text-aws-text-2">직접 구성하기 전에 완성된 구성을 보고 싶을 때만 사용하세요. 예시를 열면 구성이 모두 갖춰진 새 샌드박스가 만들어집니다.</p>
          <ul className="grid gap-4 md:grid-cols-3">
            {SAMPLES.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 rounded-xl border border-aws-border p-4">
                <p className="font-bold">{s.title}</p>
                <p className="flex-1 text-[13px] text-aws-text-2">{s.description}</p>
                <div>
                  <Button
                    onClick={() => {
                      const id = useProjectStore.getState().createFromSample(s.id);
                      if (id) open(id, "#/map");
                    }}
                  >
                    예시 열기
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </SpaceBetween>
      </ExpandableSection>

      <CreateSandboxModal
        open={creating}
        count={projects.length}
        onClose={() => setCreating(false)}
        onCreate={(name, description) => {
          const id = useProjectStore.getState().createProject(name, description);
          setCreating(false);
          open(id);
        }}
      />
      <RenameModal project={renaming} onClose={() => setRenaming(null)} />
      {deleting && (
        <DeleteModal
          open
          onClose={() => setDeleting(null)}
          title="샌드박스 삭제"
          confirmText="delete"
          onConfirm={() => {
            useProjectStore.getState().deleteProject(deleting.id);
            setSelected([]);
            return null;
          }}
        >
          <p>
            샌드박스 <strong>{deleting.name}</strong>과(와) 그 안의 가상 리소스 {deleting.resources.length}개를 이 브라우저에서 삭제합니다. 필요하면 먼저 JSON으로 내보내세요.
          </p>
        </DeleteModal>
      )}
      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        onImport={(project) => {
          const id = useProjectStore.getState().addImportedProject(project);
          setImporting(false);
          setSelected([id]);
        }}
      />
    </SpaceBetween>
  );
}

function CreateSandboxModal({ open, count, onClose, onCreate }: { open: boolean; count: number; onClose: () => void; onCreate: (name: string, description: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const n = name.trim() || `샌드박스 ${count + 1}`;
    if (n.length > 80) return setError("이름은 80자 이하여야 합니다.");
    onCreate(n, description.trim());
    setName("");
    setDescription("");
    setError(null);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="샌드박스 생성"
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={submit}>
            생성 후 콘솔 열기
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-aws-text-2">빈 가상 환경을 만듭니다. 기본 VPC도 없으므로 네트워크부터 직접 구성합니다.</p>
        <FormField label="이름" constraint="최대 80자" error={error ?? undefined}>
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`샌드박스 ${count + 1}`} maxLength={80} />
        </FormField>
        <FormField label="설명" optional>
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </FormField>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function RenameModal({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [prev, setPrev] = useState<Project | null>(null);
  if (project !== prev) {
    setPrev(project);
    setName(project?.name ?? "");
    setError(null);
  }
  if (!project) return null;
  const save = () => {
    const r = useProjectStore.getState().renameProject(project.id, name);
    if (r.ok) onClose();
    else setError(r.error);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="샌드박스 이름 변경"
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={save}>
            저장
          </Button>
        </>
      }
    >
      <FormField label="이름" error={error ?? undefined}>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </FormField>
    </Modal>
  );
}
