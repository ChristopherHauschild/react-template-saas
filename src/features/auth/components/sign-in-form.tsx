"use client";

import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";

import { signIn } from "../actions/sign-in";

export function SignInForm() {
  return (
    <form action={signIn} className="space-y-4">
      <Input name="email" type="email" placeholder="Email" required />

      <Input name="password" type="password" placeholder="Password" required />

      <Button type="submit" className="w-full">
        Sign in
      </Button>
    </form>
  );
}
