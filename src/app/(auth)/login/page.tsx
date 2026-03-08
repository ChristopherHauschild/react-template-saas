import { SignInForm } from "@/features/auth/components/sign-in-form";
import { requireGuest } from "@/infrastructure/auth/guards/require-guest";

export default async function LoginPage() {
  await requireGuest();

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-[350px]">
        <SignInForm />
      </div>
    </div>
  );
}
