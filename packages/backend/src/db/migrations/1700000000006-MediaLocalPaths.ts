import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class MediaLocalPaths1700000000006 implements MigrationInterface {
  name = "MediaLocalPaths1700000000006";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      "Media",
      new TableColumn({
        name: "localPath",
        type: "text",
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      "Media",
      new TableColumn({
        name: "localPreviewPath",
        type: "text",
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn("Media", "localPreviewPath");
    await queryRunner.dropColumn("Media", "localPath");
  }
}
