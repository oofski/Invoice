import { useParams } from "react-router-dom";
import { ApprovalView } from "@/components/ApprovalView";

/** Approvals queue. The optional :id deep-links to a focused invoice. */
export default function ApprovalsPage() {
  const { id } = useParams();
  // `key` forces a fresh ApprovalView when the deep-linked id changes.
  return <ApprovalView key={id ?? "list"} initialId={id} />;
}
