# Play again after finishing

A finished normal Discord game offers a labelled **Play again** button below its embed.
Pressing it posts a new game in the same channel, from the beginning with a new seed,
using the normal registry start path. The completed post and its finisher stay intact.
Sent custom levels retain their existing in-place replay and pencil controls.

Discord links cannot both invoke a bot interaction and navigate to a future message.
After creating the new public game response, send the clicking player an ephemeral
message with a jump link to it. Automatic client scrolling is outside the bot's control.

Reject unavailable and non-finished games privately. Starting failures appear on the
new response and never alter the completed post. Realtime games retain the normal refusal.
Verify the button, fresh record, original completion, jump destination and error paths.
