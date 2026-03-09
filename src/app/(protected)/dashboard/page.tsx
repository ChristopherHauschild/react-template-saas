import { DashboardHeader, getDashboardData } from "@/features/dashboard";

export default async function DashboardPage() {
  const data = await getDashboardData();

  return (
    <main>
      <DashboardHeader email={data.email} />
    </main>
  );
}
