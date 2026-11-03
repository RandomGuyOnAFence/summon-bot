/*
 * Summon alarm bot (Node.js).
 *
 * /enable summon   -> remembers your voice channel; the bot joins a few seconds
 *                     before the summon window opens and plays a sound.
 * /disable summon  -> stops the alarm for this server.
 * /summon status   -> shows the current cycle position.
 * /summon test     -> joins your voice channel and plays the sound right now.
 *
 * The cycle is global: position = unixSeconds % 1740 (29:00), and the summon
 * window opens at 1700 (28:20).
 */

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  MessageFlags,
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const path = require("path");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const SOUND_FILE = path.join(__dirname, "Audios", process.env.SUMMON_SOUND || "summon_voice.ogg");

const CYCLE = 1740;        // 29:00
const WINDOW_START = 1700; // 28:20
const PREJOIN = 6;         // join this many seconds early so audio starts on time

const enabled = new Map(); // guildId -> voice channelId

/* ---------------- timing ---------------- */

function cyclePos() {
  return (Date.now() / 1000) % CYCLE;
}
function secondsUntil(target) {
  return (((target - cyclePos()) % CYCLE) + CYCLE) % CYCLE;
}
function fmt(totalSeconds) {
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------------- voice ---------------- */

async function connect(guildId, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new Error("voice channel not found");

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });
  connection.on("error", (err) => console.error("Connection error:", err.message));
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  return connection;
}

function play(guildId) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  if (!fs.existsSync(SOUND_FILE)) {
    console.error("Sound file not found:", SOUND_FILE);
    connection.destroy();
    return;
  }

  const player = createAudioPlayer();
  player.on("error", (err) => {
    console.error("Audio player error:", err.message);
    connection.destroy();
  });
  connection.subscribe(player);
  player.play(createAudioResource(SOUND_FILE));
  player.once(AudioPlayerStatus.Idle, () => {
    console.log("playback finished");
    connection.destroy();
  });
  console.log("playing", SOUND_FILE);
}

/* ---------------- scheduler ---------------- */

function scheduleNext() {
  const wait = secondsUntil(WINDOW_START - PREJOIN);
  setTimeout(async () => {
    const guilds = [...enabled.entries()];
    await Promise.all(
      guilds.map(([guildId, channelId]) =>
        connect(guildId, channelId).catch((err) =>
          console.error("Could not join", guildId, err.message)
        )
      )
    );

    setTimeout(() => {
      for (const [guildId] of guilds) play(guildId);
    }, Math.max(0, secondsUntil(WINDOW_START) * 1000));

    setTimeout(scheduleNext, 3000);
  }, wait * 1000);
}

/* ---------------- commands ---------------- */

const commands = [
  new SlashCommandBuilder()
    .setName("enable")
    .setDescription("Enable a feature")
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName("summon").setDescription("Play a sound in your voice channel when the summon window opens")
    ),
  new SlashCommandBuilder()
    .setName("disable")
    .setDescription("Disable a feature")
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("summon").setDescription("Stop the summon alarm")),
  new SlashCommandBuilder()
    .setName("summon")
    .setDescription("Summon timer info")
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("status").setDescription("Show the current summon cycle position"))
    .addSubcommand((s) => s.setName("test").setDescription("Play the summon sound now in your voice channel")),
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("clientReady", async () => {
  await client.application.commands.set(commands.map((c) => c.toJSON()));
  console.log(`Logged in as ${client.user.tag}. Commands registered.`);
  scheduleNext();
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  const sub = i.options.getSubcommand();
  const voiceChannel = i.member?.voice?.channel;

  try {
    if (i.commandName === "enable" && sub === "summon") {
      if (!voiceChannel) {
        return i.reply({ content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
      }
      enabled.set(i.guildId, voiceChannel.id);
      const until = secondsUntil(WINDOW_START);
      return i.reply(
        `Summon alarm enabled for ${voiceChannel}. Window opens in ${fmt(until)}.`
      );
    }

    if (i.commandName === "disable" && sub === "summon") {
      enabled.delete(i.guildId);
      getVoiceConnection(i.guildId)?.destroy();
      return i.reply("Summon alarm disabled.");
    }

    if (i.commandName === "summon" && sub === "status") {
      const pos = cyclePos();
      return i.reply(
        pos >= WINDOW_START
          ? `Window is OPEN. Position ${fmt(pos)}, closes in ${fmt(CYCLE - pos)}.`
          : `Position ${fmt(pos)}. Window opens in ${fmt(WINDOW_START - pos)}.`
      );
    }

    if (i.commandName === "summon" && sub === "test") {
      if (!voiceChannel) {
        return i.reply({ content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
      }
      await i.deferReply();
      await connect(i.guildId, voiceChannel.id);
      play(i.guildId);
      return i.editReply("Playing the summon sound.");
    }
  } catch (err) {
    console.error("Command error:", err);
    const msg = `Something went wrong: ${err.message}`;
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
    else await i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(TOKEN);
