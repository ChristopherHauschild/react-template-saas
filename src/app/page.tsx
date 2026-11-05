import { redirect } from "next/navigation";

import { ROUTES } from "@/config/routes";

export default function Home() {
  redirect(ROUTES.dashboard);
}
