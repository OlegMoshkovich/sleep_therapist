import CategoryExplorer from "./CategoryExplorer";
import TrendingPortals from "./TrendingPortals";
import PopularExperts from "./PopularExperts";

export default function PlatformMainContent() {
  return (
    <main className="flex-1 overflow-y-auto bg-[#ECEAE3] px-4 md:px-10 py-6 md:py-10 pb-24 md:pb-10">
      <CategoryExplorer />
      <TrendingPortals />
      <PopularExperts />
    </main>
  );
}
