ALTER TABLE `ideas` ADD `project` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ideas` ADD `category` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ideas` ADD `secondary_action` text DEFAULT 'See proof' NOT NULL;