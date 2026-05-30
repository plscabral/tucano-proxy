export function shouldShowOnboarding(): boolean {
  // Real first-run logic lands in Phase 6; suppress during migration.
  return false;
}
export default function Onboarding(_props: { onClose: () => void }) {
  return null;
}
