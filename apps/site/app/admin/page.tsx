import { redirect } from "next/navigation";
import Header from "@/components/Header";
import TopoBackdrop from "@/components/TopoBackdrop";
import AdminPanel from "@/components/AdminPanel";
import { currentUser, isAdmin } from "@/lib/membership";

export const metadata = { title: "Admin — dingodirt" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await currentUser();
  if (!isAdmin(user)) redirect("/");

  return (
    <div className="relative min-h-screen">
      <TopoBackdrop />
      <Header />
      <main className="relative z-10 mx-auto max-w-5xl px-6 pb-20 pt-12 sm:px-10">
        <h1 className="font-display text-5xl font-black uppercase">Admin</h1>
        <AdminPanel />
      </main>
    </div>
  );
}
