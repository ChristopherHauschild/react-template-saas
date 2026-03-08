import { SignInForm } from "@/features/auth/components/sign-in-form";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-[350px]">
        <SignInForm />
      </div>
    </div>
  );
}
