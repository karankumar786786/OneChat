-- DropIndex
DROP INDEX "User_username_prefix_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "about" VARCHAR(140);

-- CreateIndex
CREATE INDEX "User_username_prefix_idx" ON "User"("username" text_pattern_ops);
