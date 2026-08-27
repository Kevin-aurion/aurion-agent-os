/*
  Warnings:

  - You are about to drop the `ComputerControlTask` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Lesson` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ComputerControlTask" DROP CONSTRAINT "ComputerControlTask_runId_fkey";

-- DropTable
DROP TABLE "ComputerControlTask";

-- DropTable
DROP TABLE "Lesson";
