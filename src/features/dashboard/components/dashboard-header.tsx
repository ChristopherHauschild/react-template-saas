type Props = { email: string | null };

export function DashboardHeader({ email }: Props) {
  return (
    <header>
      <h1>Dashboard</h1>
      <p>Usuário: {email}</p>
    </header>
  );
}
