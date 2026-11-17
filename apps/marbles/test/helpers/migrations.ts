import { generateMigrations } from "../../drizzle.generate";

export default function setup(): void {
  generateMigrations();
}
