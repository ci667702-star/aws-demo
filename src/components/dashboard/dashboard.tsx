"use client";

/**
 * 첫 화면.
 * 처음 온 사람이 무엇부터 할지 고민하지 않도록 '처음이라면 여기서 시작' 버튼 하나를 가장 위에 두고,
 * 나머지는 목적별로 묶는다: 따라하기(안내를 받으며) · 실습 문제(목표만 보고 스스로) · 예시(완성본 구경) · 내 샌드박스.
 * 앱이 미리 만들어 두는 프로젝트는 없다. 버튼을 누를 때 빈 샌드박스(또는 예시)를 만든다.
 */
import { ArrowRight, Cloud, GraduationCap, Moon, Sun, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DISCLAIMER } from "@/components/app/brand";
import { ClientGate } from "@/components/app/client-gate";
import { ImportDialog } from "@/components/app/import-dialog";
import { Alert } from "@/components/console/ui/alert";
import { Button, ButtonDropdown } from "@/components/console/ui/button";
import { BaseFormField as FormField, TextInput, Tiles } from "@/components/console/ui/form-base";
import { Container, ContainerHeader, ExpandableSection, PageHeader, SpaceBetween } from "@/components/console/ui/layout";
import { DeleteModal, Modal } from "@/components/console/ui/overlay";
import { TUTORIAL_TOPIC_LIST, TUTORIAL_TOPICS, type TutorialTopicId } from "@/components/console/tutorial/tutorial-topics";
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
          <span className="text-[13px] font-bold">AWSP</span>
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

type Mode = Project["preferredMode"];

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

  /** 쉬운 모드는 그림 빌더(/projects), 심화 모드는 콘솔(/console)로 연다 */
  const open = (id: string, mode: Mode = "console", hash = "#/") => router.push(mode === "easy" ? `/projects/${id}` : `/console/${id}${hash}`);

  /** 따라하기: 그 주제용 빈 샌드박스를 만들고 콘솔에서 안내를 첫 단계부터 연다 */
  const startTopic = (topicId: TutorialTopicId) => {
    const topic = TUTORIAL_TOPICS[topicId];
    const id = useProjectStore.getState().createProject(`${topic.short} 따라하기`, `따라하기 '${topic.title}'로 만든 샌드박스`, "console");
    open(id, "console", `#/?tutorial=${topicId}`);
  };
  const hasProjects = projects.length > 0;

  const onAction = (action: string, p: Project | undefined) => {
    if (!p) return;
    const store = useProjectStore.getState();
    if (action === "open") open(p.id, p.preferredMode);
    if (action === "open-easy") open(p.id, "easy");
    if (action === "open-console") open(p.id, "console");
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
        title="AWSP"
        description="AWS 콘솔과 비슷한 화면에서 네트워크와 서버를 직접 만들고 통신을 분석해 보는 학습용 시뮬레이터입니다. 실제 AWS 계정·자격 증명·요금을 쓰지 않으며, 모든 결과는 이 브라우저 안에서 계산되는 가상 결과입니다."
      />

      <QuickStart compact={hasProjects} onStart={startTopic} />

      {hasProjects && (
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
              title="내 샌드박스"
              counter={`(${projects.length})`}
              description="샌드박스는 연습용 가상 AWS 환경입니다. 여러 개를 만들어 서로 영향 없이 따로 연습할 수 있습니다."
              actions={
                <>
                  <ButtonDropdown
                    label="작업"
                    disabled={!current}
                    items={[
                      { id: "open", text: "열기" },
                      { id: "open-easy", text: "그림 빌더로 열기" },
                      { id: "open-console", text: "콘솔로 열기" },
                      { id: "rename", text: "이름 변경" },
                      { id: "duplicate", text: "복제" },
                      { id: "export", text: "JSON으로 내보내기" },
                      { id: "delete", text: "삭제", danger: true },
                    ]}
                    onItemClick={(a) => onAction(a, current)}
                  />
                  <Button onClick={() => setImporting(true)}>가져오기</Button>
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    빈 샌드박스 만들기
                  </Button>
                </>
              }
            />
          }
          columns={[
            {
              id: "name",
              header: "이름",
              minWidth: 190,
              cell: (p) => (
                <a href={p.preferredMode === "easy" ? `/projects/${p.id}` : `/console/${p.id}#/`} className="font-bold whitespace-nowrap text-aws-link hover:underline" data-testid="sandbox-link">
                  {p.name}
                </a>
              ),
              sortValue: (p) => p.name,
              filterValue: (p) => `${p.name} ${p.description}`,
            },
            { id: "mode", header: "화면", cell: (p) => (p.preferredMode === "easy" ? <Badge color="orange">쉬운 모드</Badge> : <Badge color="blue">심화 모드</Badge>) },
            { id: "lab", header: "실습 문제", cell: (p) => (p.labId ? <Badge color="blue">{LABS.find((l) => l.id === p.labId)?.title ?? p.labId}</Badge> : "–") },
            { id: "resources", header: "리소스", cell: (p) => `${stats(p).resources}개`, sortValue: (p) => stats(p).resources },
            { id: "vpcs", header: "VPC", cell: (p) => stats(p).vpcs },
            { id: "running", header: "실행 중인 인스턴스", cell: (p) => stats(p).running },
            { id: "updated", header: "마지막 수정", cell: (p) => <span title={formatDateTime(p.updatedAt)}>{formatRelativeTime(p.updatedAt)}</span>, sortValue: (p) => p.updatedAt },
            { id: "created", header: "생성일", cell: (p) => formatDateTime(p.createdAt), sortValue: (p) => p.createdAt },
          ]}
        />
      )}

      <Container
        header={
          <ContainerHeader
            title="따라하기"
            description="이런 분께: 안내를 받으며 한 단계씩 만들어 보고 싶은 분. 주제를 고르면 빈 샌드박스가 만들어지고, 오른쪽 안내 패널이 할 일을 알려 주며 설정이 맞으면 '완료'로 표시합니다."
          />
        }
      >
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TUTORIAL_TOPIC_LIST.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => startTopic(t.id as TutorialTopicId)}
                className="group flex h-full w-full flex-col gap-1.5 rounded-xl border border-aws-border p-4 text-left hover:border-aws-link hover:bg-aws-surface-2"
                data-testid="topic-card"
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="font-bold text-aws-text group-hover:text-aws-link">{t.title}</span>
                  <Badge>약 {t.minutes}분</Badge>
                </span>
                <span className="flex-1 text-[13px] leading-relaxed text-aws-text-2">{t.description}</span>
                <span className="inline-flex items-center gap-1 text-sm font-bold text-aws-link">
                  시작하기 <ArrowRight className="size-4" aria-hidden />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Container>

      <Container
        header={
          <ContainerHeader
            title="실습 문제"
            description="이런 분께: 목표만 보고 방법은 스스로 찾아보고 싶은 분. 실습을 시작하면 빈 샌드박스가 만들어지고, 단계별 목표의 완료 여부를 실제 설정과 분석 결과로 자동 판정합니다."
          />
        }
      >
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
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    const id = useProjectStore.getState().startLab(lab.id, "console");
                    if (id) open(id, "console", "#/?tools=labs");
                  }}
                >
                  실습 시작
                </Button>
                <Button
                  variant="link"
                  onClick={() => {
                    const id = useProjectStore.getState().startLab(lab.id, "easy");
                    if (id) open(id, "easy");
                  }}
                >
                  쉬운 모드로 시작
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Container>

      <ExpandableSection variant="container" header="예시 구경하기 (완성된 구성)">
        <SpaceBetween size="m">
          <p className="text-sm text-aws-text-2">이런 분께: 직접 만들기 전에 완성된 구성을 먼저 보고 싶은 분. 예시를 열면 구성이 모두 갖춰진 새 샌드박스가 만들어집니다.</p>
          <ul className="grid gap-4 md:grid-cols-3">
            {SAMPLES.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 rounded-xl border border-aws-border p-4">
                <p className="font-bold">{s.title}</p>
                <p className="flex-1 text-[13px] text-aws-text-2">{s.description}</p>
                <div>
                  <Button
                    onClick={() => {
                      const id = useProjectStore.getState().createFromSample(s.id);
                      if (id) open(id, "console", "#/map");
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

      {!hasProjects && (
        <Container
          header={
            <ContainerHeader
              title="내 샌드박스"
              description="샌드박스는 연습용 가상 AWS 환경입니다. 여러 개를 만들어 서로 영향 없이 따로 연습할 수 있습니다."
              actions={
                <>
                  <Button onClick={() => setImporting(true)}>가져오기</Button>
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    빈 샌드박스 만들기
                  </Button>
                </>
              }
            />
          }
        >
          <p className="text-[15px] text-aws-text-2" data-testid="no-sandbox">
            아직 샌드박스가 없습니다. 위에서 따라하기를 시작하거나, 빈 샌드박스를 만들어 처음부터 자유롭게 구성해 보세요.
          </p>
        </Container>
      )}

      <CreateSandboxModal
        open={creating}
        count={projects.length}
        onClose={() => setCreating(false)}
        onCreate={(name, description, mode) => {
          const id = useProjectStore.getState().createProject(name, description, mode);
          setCreating(false);
          open(id, mode);
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

function CreateSandboxModal({ open, count, onClose, onCreate }: { open: boolean; count: number; onClose: () => void; onCreate: (name: string, description: string, mode: Mode) => void }) {
  const [name, setName] = useState("");
  // 처음 배우는 사람에게 맞는 쉬운 모드를 기본으로 고른다 (따라하기는 첫 화면의 버튼으로 심화 모드에서 시작한다)
  const [mode, setMode] = useState<Mode>("easy");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const n = name.trim() || `샌드박스 ${count + 1}`;
    if (n.length > 20) return setError("이름은 20자 이하여야 합니다.");
    onCreate(n, description.trim(), mode);
    setName("");
    setDescription("");
    setError(null);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="빈 샌드박스 만들기"
      footer={
        <>
          <Button variant="link" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={submit}>
            생성 후 열기
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
        <FormField label="어떤 화면으로 시작할까요?" description="나중에 언제든 바꿀 수 있습니다. 두 화면은 같은 샌드박스를 보여 줍니다.">
          <Tiles
            aria-label="시작 화면"
            columns={2}
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            items={[
              {
                value: "easy",
                label: (
                  <span className="flex flex-wrap items-center gap-1.5">
                    쉬운 모드 <Badge color="green">처음이면 추천</Badge>
                  </span>
                ),
                description: "리소스를 끌어다 놓고 선으로 연결하는 그림 빌더입니다. 기본값이 자동으로 채워져 처음 배우기 좋습니다.",
                image: <EasyModePreview />,
              },
              {
                value: "console",
                label: "심화 모드",
                description: "AWS 콘솔처럼 메뉴와 양식으로 하나씩 설정합니다. 따라하기와 IAM·S3 같은 서비스는 이 화면에서 합니다.",
                image: <ConsoleModePreview />,
              },
            ]}
          />
        </FormField>
        <FormField label="이름" constraint="최대 20자" error={error ?? undefined}>
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`샌드박스 ${count + 1}`} maxLength={20} />
        </FormField>
        <FormField label="설명" optional>
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </FormField>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** 맨 위의 시작 버튼. 샌드박스가 이미 있으면(다시 온 사람) 한 줄로 줄인다 */
function QuickStart({ compact, onStart }: { compact: boolean; onStart: (topicId: TutorialTopicId) => void }) {
  if (compact) {
    return (
      <section aria-label="처음이라면" className="flex flex-wrap items-center gap-3 rounded-2xl border border-aws-link/30 bg-aws-info-bg px-5 py-3" data-testid="quick-start">
        <GraduationCap className="size-5 shrink-0 text-aws-link" aria-hidden />
        <p className="min-w-0 flex-1 text-[15px] text-aws-text">처음이라면 안내를 따라 첫 웹 서버를 만들어 보세요. 단계마다 할 일을 알려 줍니다.</p>
        <Button variant="primary" onClick={() => onStart("first-web-server")}>
          첫 웹 서버 따라하기 시작
        </Button>
      </section>
    );
  }
  return (
    <section aria-labelledby="quick-start-title" className="rounded-2xl border-2 border-aws-link/40 bg-aws-info-bg p-6 sm:p-8" data-testid="quick-start">
      <div className="flex flex-col gap-5 md:flex-row md:items-center">
        <GraduationCap className="size-10 shrink-0 text-aws-link" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 id="quick-start-title" className="text-xl font-bold text-aws-text sm:text-2xl">
            처음이라면 여기서 시작하세요
          </h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-aws-text-2">
            버튼 하나로 연습용 샌드박스가 만들어지고, 화면 오른쪽 안내가 첫 웹 서버를 만드는 과정을 한 단계씩 알려 줍니다. 약 {TUTORIAL_TOPICS["first-web-server"].minutes}분 걸리며, 단계마다 실제
            설정이 맞는지 확인해 &apos;완료&apos;로 표시합니다.
          </p>
          <p className="text-[13px] text-aws-text-2">VPC → 서브넷 → 인터넷 게이트웨이 → 라우팅 → 보안 그룹 → EC2 → 통신 확인</p>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2 md:items-end">
          <Button variant="primary" className="h-11 px-6 text-[15px]" onClick={() => onStart("first-web-server")}>
            첫 웹 서버 따라하기 시작
          </Button>
          <Button variant="link" onClick={() => onStart("console-tour")}>
            화면부터 둘러보기 ({TUTORIAL_TOPICS["console-tour"].minutes}분)
          </Button>
        </div>
      </div>
    </section>
  );
}

/** 모드 선택 카드의 작은 그림: 쉬운 모드(캔버스의 상자와 선) */
function EasyModePreview() {
  return (
    <svg viewBox="0 0 72 48" className="h-12 w-[72px] shrink-0 text-aws-link" aria-hidden>
      <rect x="1" y="1" width="70" height="46" rx="6" className="fill-aws-surface-2" stroke="currentColor" strokeOpacity="0.25" />
      <rect x="7" y="7" width="58" height="34" rx="4" fill="none" stroke="currentColor" strokeDasharray="3 2" strokeOpacity="0.6" />
      <rect x="13" y="14" width="16" height="10" rx="2" fill="currentColor" fillOpacity="0.85" />
      <rect x="43" y="25" width="16" height="10" rx="2" fill="currentColor" fillOpacity="0.55" />
      <path d="M29 19 C37 19 37 30 43 30" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** 모드 선택 카드의 작은 그림: 심화 모드(메뉴와 양식) */
function ConsoleModePreview() {
  return (
    <svg viewBox="0 0 72 48" className="h-12 w-[72px] shrink-0 text-aws-link" aria-hidden>
      <rect x="1" y="1" width="70" height="46" rx="6" className="fill-aws-surface-2" stroke="currentColor" strokeOpacity="0.25" />
      <rect x="1" y="1" width="70" height="8" rx="3" fill="currentColor" fillOpacity="0.85" />
      <rect x="6" y="14" width="14" height="3" rx="1.5" fill="currentColor" fillOpacity="0.5" />
      <rect x="6" y="21" width="12" height="3" rx="1.5" fill="currentColor" fillOpacity="0.5" />
      <rect x="6" y="28" width="14" height="3" rx="1.5" fill="currentColor" fillOpacity="0.5" />
      <rect x="26" y="14" width="40" height="6" rx="2" fill="none" stroke="currentColor" strokeOpacity="0.6" />
      <rect x="26" y="24" width="40" height="6" rx="2" fill="none" stroke="currentColor" strokeOpacity="0.6" />
      <rect x="48" y="35" width="18" height="6" rx="3" fill="currentColor" fillOpacity="0.85" />
    </svg>
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
        <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
      </FormField>
    </Modal>
  );
}
