"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/infrastructure/auth/supabase/server";

export async function signUp(formData: FormData) {
  const supabase = await createClient();

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  const { error } = await supabase.auth.signUp({ email, password });

  if (error) {
    throw new Error(error.message);
  }

  redirect("/");
}
