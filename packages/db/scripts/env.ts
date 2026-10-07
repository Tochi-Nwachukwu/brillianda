export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env at the repo root and fill it in.`);
    process.exit(1);
  }
  return value;
}
