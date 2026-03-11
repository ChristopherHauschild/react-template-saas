import { getDashboardData, MetricsCards, RevenueChart } from "@/features/dashboard";

export default async function DashboardPage() {
  const data = await getDashboardData();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold">Welcome back 👋</h2>

        <p className="text-muted-foreground text-sm">Logged in as {data.email}</p>
      </div>

      <MetricsCards />

      <RevenueChart />
    </div>
  );
}
