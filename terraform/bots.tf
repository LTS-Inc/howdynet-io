# Finding 1: "Review unwanted AI crawlers with AI Labyrinth".
# Finding 3: "Bot Fight Mode not enabled".
#
# Only Free-plan fields are set. sbfm_* (Super Bot Fight Mode) and Bot Management
# fields are Pro+/Enterprise and must not be added here.
resource "cloudflare_bot_management" "zone" {
  zone_id            = local.zone_id
  fight_mode         = true      # Bot Fight Mode
  ai_bots_protection = "block"   # Block AI bots
  crawler_protection = "enabled" # AI Labyrinth
  enable_js          = true      # JavaScript detections
}
