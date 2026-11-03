"""
Summon alarm bot.

/enable summon  -> bot joins your current voice channel and plays a sound
                   every time the global summon window opens (28:20 of the
                   29:00 cycle, aligned to Unix time).
/disable summon -> bot stops and leaves the voice channel.
/summon status  -> shows the current cycle position and time until window.
"""

import asyncio
import os
import time

import discord
from discord import app_commands

CYCLE = 1740          # 29:00 in seconds
WINDOW_START = 1700   # 28:20 in seconds
SOUND_FILE = os.getenv("SUMMON_SOUND", os.path.join(os.path.dirname(os.path.abspath(__file__)), "summon.wav"))
TOKEN = os.environ["DISCORD_TOKEN"]


def fmt(seconds: int) -> str:
    return f"{seconds // 60}:{seconds % 60:02d}"


class SummonBot(discord.Client):
    def __init__(self):
        super().__init__(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self)
        self.enabled: dict[int, int] = {}  # guild_id -> voice channel id

    async def setup_hook(self):
        await self.tree.sync()
        asyncio.create_task(self.summon_loop())

    async def summon_loop(self):
        await self.wait_until_ready()
        while not self.is_closed():
            pos = time.time() % CYCLE
            wait = (WINDOW_START - pos) % CYCLE
            await asyncio.sleep(wait + 0.05)
            await asyncio.gather(
                *(self.play_in_guild(g, c) for g, c in list(self.enabled.items())),
                return_exceptions=True,
            )
            await asyncio.sleep(1)

    async def play_in_guild(self, guild_id: int, channel_id: int):
        guild = self.get_guild(guild_id)
        channel = guild.get_channel(channel_id) if guild else None
        if channel is None:
            self.enabled.pop(guild_id, None)
            return

        vc = guild.voice_client
        if vc is None or not vc.is_connected():
            vc = await channel.connect()
        elif vc.channel.id != channel.id:
            await vc.move_to(channel)

        if vc.is_playing():
            vc.stop()
        vc.play(discord.FFmpegPCMAudio(SOUND_FILE))


bot = SummonBot()

enable = app_commands.Group(name="enable", description="Enable a feature", guild_only=True)
disable = app_commands.Group(name="disable", description="Disable a feature", guild_only=True)
summon = app_commands.Group(name="summon", description="Summon timer info", guild_only=True)


@enable.command(name="summon", description="Join your voice channel and play a sound when the summon window opens")
async def enable_summon(interaction: discord.Interaction):
    voice = getattr(interaction.user, "voice", None)
    if voice is None or voice.channel is None:
        await interaction.response.send_message("Join a voice channel first.", ephemeral=True)
        return

    await interaction.response.defer()
    channel = voice.channel
    vc = interaction.guild.voice_client
    if vc is None or not vc.is_connected():
        await channel.connect()
    elif vc.channel.id != channel.id:
        await vc.move_to(channel)

    bot.enabled[interaction.guild_id] = channel.id
    pos = int(time.time() % CYCLE)
    until = WINDOW_START - pos if pos < WINDOW_START else CYCLE - pos + WINDOW_START
    await interaction.followup.send(
        f"Summon alarm enabled in {channel.mention}. Window opens in {fmt(until)}."
    )


@disable.command(name="summon", description="Stop the summon alarm and leave voice")
async def disable_summon(interaction: discord.Interaction):
    bot.enabled.pop(interaction.guild_id, None)
    vc = interaction.guild.voice_client
    if vc:
        await vc.disconnect()
    await interaction.response.send_message("Summon alarm disabled.")


@summon.command(name="status", description="Show the current summon cycle position")
async def summon_status(interaction: discord.Interaction):
    pos = int(time.time() % CYCLE)
    if pos >= WINDOW_START:
        msg = f"Window is OPEN. Position {fmt(pos)}, closes in {fmt(CYCLE - pos)}."
    else:
        msg = f"Position {fmt(pos)}. Window opens in {fmt(WINDOW_START - pos)}."
    await interaction.response.send_message(msg)


bot.tree.add_command(enable)
bot.tree.add_command(disable)
bot.tree.add_command(summon)

bot.run(TOKEN)
