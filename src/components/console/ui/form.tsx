"use client";

/**
 * 콘솔 양식 입력 요소.
 * 기본 요소는 form-base.tsx에 있고, 여기서는 설정 도움말(?)을 붙인 FormField를 더한다.
 * (설정 도움말은 설명 데이터 전체를 쓰므로, 도움말이 필요 없는 화면은 form-base를 직접 가져온다)
 */
import { FieldHelpButton } from "@/components/docs/field-help";
import type { DocKey } from "@/lib/docs/types";
import { BaseFormField, type BaseFormFieldProps } from "./form-base";

export * from "./form-base";

/** 레이블, 설명, 제약 조건, 오류를 갖춘 입력 필드 */
export function FormField({
  help,
  ...props
}: BaseFormFieldProps & {
  /** 설정 항목 도움말 (리소스 설명 데이터의 설정 키) */
  help?: { docKey: DocKey; field: string };
}) {
  return (
    <BaseFormField
      {...props}
      dataField={help?.field}
      helpButton={help ? <FieldHelpButton docKey={help.docKey} field={help.field} side="bottom" className="size-5 [&_svg]:size-4" /> : undefined}
    />
  );
}
