import "reflect-metadata";
import { parseAppFlags, runMonolith } from "./app/roles";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required!");
  process.exit(1);
}

if (process.argv.includes("--help")) {
  const help = [
    `${process.env.npm_package_name}@${process.env.npm_package_version}`,
    "",
    "Usage:",
    "",
    "pnpm run start -- --no-full-sync      disable full sync (initial + periodic)",
    "pnpm run start -- --no-api-server     disable api server",
    "",
    "pnpm run start:cluster                N API workers (CPU count) + sync in primary",
    "CLUSTER_WORKERS=2 pnpm run start:cluster   override worker count",
    "",
    "For configuration look at .env.example file",
  ];
  console.log(help.join("\n"));
  process.exit(0);
}

runMonolith(parseAppFlags());
