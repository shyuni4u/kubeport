import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { CliConnect } from "@/components/CliConnect";

export default async function CliPage() {
  if (!await getSession()) redirect("/?next=%2Fcli");
  return <CliConnect />;
}
