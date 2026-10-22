"use client";

import { FileJson, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Project } from "@/lib/engine/resource-models";
import { MAX_IMPORT_BYTES, parseProjectJson } from "@/lib/project/serialization";

/**
 * JSON 가져오기. 스키마와 리소스 참조를 검증하고, 실패하면 아무것도 바꾸지 않고 오류만 보여준다.
 * 성공하면 항상 "새 프로젝트"로 추가하므로 기존 프로젝트는 손상되지 않는다.
 */
export function ImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (project: Project) => void;
}) {
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setText("");
    setErrors([]);
    setFileName(null);
  };

  const readFile = async (file: File) => {
    setErrors([]);
    if (file.size > MAX_IMPORT_BYTES) {
      setErrors([`파일이 너무 큽니다. (최대 ${MAX_IMPORT_BYTES / 1024 / 1024}MB)`]);
      return;
    }
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch (e) {
      setErrors([`파일을 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`]);
    }
  };

  const submit = () => {
    const result = parseProjectJson(text);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onImport(result.project);
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>프로젝트 JSON 가져오기</DialogTitle>
          <DialogDescription>
            내보낸 프로젝트 파일을 선택하거나 JSON을 붙여넣으세요. 검증을 통과하면 새 프로젝트로 추가되며 기존 프로젝트는 변경되지
            않습니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="JSON 파일 선택"
            data-testid="import-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
              e.target.value = "";
            }}
          />
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload /> 파일 선택
          </Button>
          {fileName && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileJson className="size-3.5" aria-hidden /> {fileName}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="import-json">JSON</Label>
            <textarea
              id="import-json"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setErrors([]);
              }}
              rows={8}
              spellCheck={false}
              className="h-44 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              placeholder='{"format": "aws-playground-project", "project": { ... }}'
            />
          </div>
          {errors.length > 0 && (
            <div role="alert" className="max-h-48 overflow-auto rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <p className="mb-1 font-medium">가져오기 실패 — 현재 프로젝트는 변경되지 않았습니다.</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={submit} disabled={!text.trim()}>
            검증 후 가져오기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
