"use client";

import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";

import { signIn } from "../actions/sign-in";

export function SignInForm() {
  return (
    <Card className="w-full max-w-md border-border/60 bg-card/80 backdrop-blur shadow-xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>
          Enter your email and password to access your account
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={signIn} className="space-y-5">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input name="email" type="email" placeholder="john@company.com" required />
          </div>

          <div className="space-y-2">
            <Label>Password</Label>
            <Input name="password" type="password" placeholder="••••••••" required />
          </div>

          <Button className="w-full">Sign in</Button>
        </form>
      </CardContent>
    </Card>
  );
}
