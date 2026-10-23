"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * sonner 토스트. 읽기 쉽도록 밝은 카드 + 왼쪽 색 띠 + 큰 제목으로 표시한다.
 * 위치는 상단 가운데(상단 메뉴 바로 아래): 양식의 오른쪽 아래 버튼이나 머리글의 오른쪽 작업 버튼을 가리지 않는다.
 * (오른쪽 아래에 두면 방금 누른 버튼 위에 마우스가 남아 토스트가 펼쳐진 채 멈추고 다음 화면의 버튼을 덮었다)
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-center"
      offset={{ top: 64 }}
      mobileOffset={{ top: 60, left: 12, right: 12 }}
      visibleToasts={4}
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-5" />,
        info: <InfoIcon className="size-5" />,
        warning: <TriangleAlertIcon className="size-5" />,
        error: <OctagonXIcon className="size-5" />,
        loading: <Loader2Icon className="size-5 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--aws-surface)",
          "--normal-text": "var(--aws-text)",
          "--normal-border": "var(--aws-border)",
          "--border-radius": "14px",
          "--width": "380px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast items-start! gap-3! p-4! shadow-xl! border-l-[6px]!",
          title: "text-[15px]! leading-snug! font-bold!",
          description: "text-sm! leading-relaxed! text-aws-text-2! mt-1!",
          success: "border-l-aws-success! [&_[data-icon]]:text-aws-success!",
          error: "border-l-aws-error! [&_[data-icon]]:text-aws-error!",
          warning: "border-l-aws-warning! [&_[data-icon]]:text-aws-warning!",
          info: "border-l-aws-info! [&_[data-icon]]:text-aws-info!",
          actionButton: "rounded-full! bg-aws-primary! text-aws-primary-fg! font-bold! px-3! h-8! text-[13px]! self-center!",
          closeButton: "bg-aws-surface! border-aws-border! text-aws-text-2!",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
