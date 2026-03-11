import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";

type Metric = {
  title: string;
  value: string;
  description?: string;
};

const metrics: Metric[] = [
  {
    title: "Revenue",
    value: "$2,430",
    description: "+12% from last month",
  },
  {
    title: "Customers",
    value: "148",
    description: "+8 new this week",
  },
  {
    title: "Active users",
    value: "1,024",
    description: "+4% this week",
  },
  {
    title: "Conversion rate",
    value: "3.2%",
    description: "+0.4%",
  },
];

export function MetricsCards() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <Card
          key={metric.title}
          className="border-border/60 bg-card/80 backdrop-blur hover:shadow-md transition"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {metric.title}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className="text-2xl font-bold">{metric.value}</div>

            {metric.description && (
              <p className="text-xs text-muted-foreground mt-1">{metric.description}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
