import { SignUpForm } from "@/features/auth/components/sign-up-form";
import { requireGuest } from "@/infrastructure/auth/guards/require-guest";

export default async function SignUpPage() {
  await requireGuest();

  return (
    <div className="m-auto w-[350px]">
      <SignUpForm />
    </div>
  );
}
