import { SiClaude, SiGooglegemini, SiOpenai } from "react-icons/si";
import type { McpClient } from "@/lib/ipc";
import ohMyPiLogo from "@/assets/oh-my-pi.svg";
import antigravityLogo from "@/assets/antigravity.svg";

// Grok/OpenCode marks: https://github.com/lobehub/lobe-icons (MIT).
// Pi mark: https://pi.dev/logo-auto.svg, linked by badlogic/pi-mono.
export default function McpClientLogo({ client }: { client: McpClient | "pi" }) {
  const icon = (() => {
    switch (client) {
      case "ohMyPi":
        return <img src={ohMyPiLogo} width={28} height={28} alt="" />;
      case "antigravity":
        return <img src={antigravityLogo} width={26} height={26} alt="" />;
      case "claudeDesktop":
      case "claudeCode":
        return <SiClaude size={24} className="text-[#D97757]" />;
      case "codexDesktop":
      case "codex":
        return <SiOpenai size={24} />;
      case "gemini":
        return <SiGooglegemini size={24} className="text-[#4285F4]" />;
      case "opencode":
      case "opencodeDesktop":
        return <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd"><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" /></svg>;
      case "grok":
        return <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" /></svg>;
      case "pi":
        return <svg width="28" height="28" viewBox="0 0 800 800" fill="currentColor"><path fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" /><path d="M517.36 400H634.72V634.72H517.36Z" /></svg>;
    }
  })();
  return <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-50 dark:bg-white/[0.06]">{icon}</span>;
}
