import { ApprovalView } from "@/components/ApprovalView";

export const dynamic = "force-dynamic";

/** Deep link target for approval emails (Brief §04 step 6). */
export default function ApprovalDeepLinkPage({
  params,
}: {
  params: { id: string };
}) {
  return <ApprovalView initialId={params.id} />;
}
