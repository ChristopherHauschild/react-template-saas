import { Activity, DollarSign, TrendingUp, Users } from "lucide-react";

import { Card } from "@/shared/components/ui/card";

export function MetricsCards() {
  const metrics = [
    {
      title: "Revenue",
      value: "$2,430",
      description: "+12% from last month",
      icon: DollarSign,
    },
    {
      title: "Customers",
      value: "148",
      description: "+8 new this week",
      icon: Users,
    },
    {
      title: "Active users",
      value: "1,024",
      description: "+4% this week",
      icon: Activity,
    },
    {
      title: "Conversion rate",
      value: "3.2%",
      description: "+0.4%",
      icon: TrendingUp,
    },
  ];

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      {metrics.map((metric) => {
        const Icon = metric.icon;

        return (
          <Card key={metric.title} className="p-5 shadow-sm hover:shadow-md transition">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{metric.title}</p>

                <p className="text-2xl font-semibold">{metric.value}</p>
              </div>

              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon size={20} />
              </div>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">{metric.description}</p>
          </Card>
        );
      })}
    </div>
  );
}
