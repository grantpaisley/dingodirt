import GalleryPage from "@/components/GalleryPage";

export const metadata = { title: "Rides — dingodirt" };
export const dynamic = "force-dynamic";

export default function RidesPage() {
  return <GalleryPage type="ride" />;
}
