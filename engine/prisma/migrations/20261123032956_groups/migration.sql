-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('member', 'admin');

-- DropIndex
DROP INDEX "User_username_prefix_idx";

-- AlterTable
ALTER TABLE "PendingEvent" ADD COLUMN     "groupId" UUID;

-- CreateTable
CREATE TABLE "Group" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(512),
    "avatarFileId" UUID,
    "createdById" UUID NOT NULL,
    "onlyAdminsCanSend" BOOLEAN NOT NULL DEFAULT false,
    "onlyAdminsCanEditInfo" BOOLEAN NOT NULL DEFAULT false,
    "inviteCode" VARCHAR(32),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "GroupRole" NOT NULL DEFAULT 'member',
    "addedById" UUID,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mutedUntil" TIMESTAMP(3),

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Group_inviteCode_key" ON "Group"("inviteCode");

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- CreateIndex
CREATE INDEX "PendingEvent_messageId_idx" ON "PendingEvent"("messageId");

-- CreateIndex
CREATE INDEX "User_username_prefix_idx" ON "User"("username" text_pattern_ops);

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
