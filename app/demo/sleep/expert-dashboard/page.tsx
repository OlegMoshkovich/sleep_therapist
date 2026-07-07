import { redirect } from "next/navigation";
import Link from "next/link";
import { createSupabaseServerClient } from "../../../lib/supabase-server";
import SiteNavbar from "../../../components/SiteNavbar";
import ExpertDashboard from "../../../components/chat/ExpertDashboard";

export default async function SleepExpertDashboardPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/demo/sleep");
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#E1DECF] flex flex-col">
      <SiteNavbar activePage="demos" />
      <div className="flex-1">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-4 border-b border-gray-300 flex items-end justify-between">
            <div>
              <p className="text-xs font-sans tracking-widest uppercase text-gray-500">
                Demo No.2 — Expert View
              </p>
              <h1 className="text-2xl font-bold font-test-american-grotesk text-black">
                Sleep — All Conversations
              </h1>
            </div>
            <div className="flex items-center gap-4 pb-1">
              <Link href="/demo/sleep" className="text-xs text-gray-500 underline hover:text-gray-700">
                Chat
              </Link>
              <Link href="/demo/sleep/input" className="text-xs text-gray-500 underline hover:text-gray-700">
                Setup
              </Link>
            </div>
          </div>
          <ExpertDashboard apiEndpoint="/api/admin/sleep/conversations" />
        </div>
      </div>
    </div>
  );
}
