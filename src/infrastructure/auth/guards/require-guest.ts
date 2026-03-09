import { redirect } from "next/navigation";

import { getCurrentUser } from "../utils/get-current-user";

export async function requireGuest() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/dashboard");
  }
}
