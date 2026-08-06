import GalleryPage from "@/components/GalleryPage";

export const metadata = { title: "Schemes — dingodirt" };
export const dynamic = "force-dynamic";

export default function SchemesPage() {
  return <GalleryPage type="scheme" />;
}
