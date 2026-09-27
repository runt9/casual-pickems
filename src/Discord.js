/**
 * Discord posts through the webhook in Script Property DISCORD_WEBHOOK_URL (a secret: never in
 * the repo). Nothing is posted while it is unset. Posts carry names and totals, never picks.
 *
 *  - Reminder: CONFIG.DISCORD_REMINDER_HOURS_BEFORE_FIRST_KICKOFF before the first kickoff of each
 *    game day (US Eastern date), if anyone has an open game that day unpicked, or no lock in a
 *    regular-season week.
 *  - Results: as soon as a week is complete.
 *
 * Runs inside sync_'s script lock, so deciding, posting and recording a post cannot interleave
 * with another sync. A failed post is not recorded, so the next sync retries it.
 */

/**
 * What has been posted, stored under PropertyKey.DISCORD.
 * @typedef {Object} DiscordState
 * @property {Array<number>} postedWeeks    weeks whose results were posted (or were complete before posting began)
 * @property {Array<string>} remindedDays   game days (yyyy-MM-dd, US Eastern) whose reminder is done
 */

/**
 * @param {Object<string, Game>} games
 * @param {Object<number, WeekPicks>} allPicks
 * @param {Array<Player>} players
 */
function notifyDiscord_(games, allPicks, players, nowMs) {
  const webhookUrl = props_().getProperty(PropertyKey.DISCORD_WEBHOOK_URL);
  if (!webhookUrl) return;
  const season = seasonSummary_(games, allPicks, players, nowMs);

  // The first run after the webhook is set marks weeks already complete as posted, so turning
  // the feature on mid-season does not post a backlog.
  let state = readJson_(PropertyKey.DISCORD, null);
  if (!state) {
    const completeWeeks = season.weeks.filter((week) => week.complete).map((week) => week.week);
    state = { postedWeeks: completeWeeks, remindedDays: [] };
    writeJson_(PropertyKey.DISCORD, state);
  }

  season.weeks
    .filter((week) => week.complete)
    .filter((week) => !state.postedWeeks.includes(week.week))
    .forEach((week) => {
      postToDiscord_(webhookUrl, resultsText_(week, season, players));
      state.postedWeeks.push(week.week);
      writeJson_(PropertyKey.DISCORD, state);
    });

  gameDays_(games)
    .filter((day) => !state.remindedDays.includes(day.key))
    .filter((day) => reminderDue_(day, nowMs))
    .forEach((day) => {
      const text = reminderText_(day, allPicks, players, nowMs);
      // Everyone is set: the day counts as reminded, and nothing is posted.
      if (text) postToDiscord_(webhookUrl, text);
      state.remindedDays.push(day.key);
      writeJson_(PropertyKey.DISCORD, state);
    });
}

/**
 * Live games with a known kickoff, grouped by US Eastern date.
 * @return {Array<{key: string, games: Array<Game>}>}  each day's games sorted by kickoff
 */
function gameDays_(games) {
  const gamesByDay = new Map();
  liveGames_(games)
    .filter((game) => game.kickoffMs !== null && game.kickoffMs !== undefined)
    .forEach((game) => {
      const key = Utilities.formatDate(new Date(game.kickoffMs), CONFIG.DATA_TIMEZONE, 'yyyy-MM-dd');
      if (!gamesByDay.has(key)) gamesByDay.set(key, []);
      gamesByDay.get(key).push(game);
    });
  return [...gamesByDay].map(([key, dayGames]) => ({
    key,
    games: dayGames.sort((first, second) => first.kickoffMs - second.kickoffMs),
  }));
}

/** From the reminder time until the day's first game freezes; after that the day has started. */
function reminderDue_(day, nowMs) {
  const firstGame = day.games[0];
  const remindAtMs = firstGame.kickoffMs - CONFIG.DISCORD_REMINDER_HOURS_BEFORE_FIRST_KICKOFF * 3600 * 1000;
  if (nowMs < remindAtMs) return false;
  return !isFrozen_(firstGame, nowMs);
}

/**
 * The reminder for one game day, or null when nobody is missing anything:
 *
 *   Next games: first kickoff Sun Sep 27, 12:00 PM US Central / Sun Sep 27, 7:00 PM Central Europe.
 *   Still to pick: Al (3 games), Bob (1 game)
 *   No lock this week: Bob
 *
 * @param {{key: string, games: Array<Game>}} day
 * @param {Object<number, WeekPicks>} allPicks
 * @param {Array<Player>} players
 * @return {?string}
 */
function reminderText_(day, allPicks, players, nowMs) {
  const { week, type, kickoffMs } = day.games[0];
  const weekPicks = allPicks[week] || {};
  const picksOf = (player) => weekPicks[player.id] || emptyPlayerPicks_();
  const openGames = day.games.filter((game) => !isFrozen_(game, nowMs));

  const unpickedCount = (player) => openGames
    .filter((game) => playsGame_(player, game))
    .filter((game) => !picksOf(player).picks[game.id])
    .length;
  const stillToPick = players
    .filter((player) => unpickedCount(player) > 0)
    .map((player) => {
      const count = unpickedCount(player);
      return `${player.name} (${count} ${count === 1 ? 'game' : 'games'})`;
    });
  const locksAllowed = roundInfo_(type).locks;
  const noLock = locksAllowed ? players.filter((player) => !picksOf(player).lock).map((player) => player.name) : [];
  if (!stillToPick.length && !noLock.length) return null;

  const kickoffTimes = CONFIG.SHEET_TIMEZONES.map(({ label, tz }) => `${fmtTime_(kickoffMs, tz)} ${label}`);
  const lines = [`Next games: first kickoff ${kickoffTimes.join(' / ')}.`];
  if (stillToPick.length) lines.push(`Still to pick: ${stillToPick.join(', ')}`);
  if (noLock.length) lines.push(`No lock this week: ${noLock.join(', ')}`);
  return lines.join('\n');
}

/**
 * The results post for a complete week. Week points list only players who were in the week;
 * the season line is the regular season during it, the full season in the playoffs.
 *
 *   Week 3 final: Al +22.5, Cy +10, Bob -3. Winner: Al
 *   Regular season: Al +120.5, Cy +98, Bob +80
 *
 * @param {WeekInfo & WeekSummary} week
 * @param {SeasonSummary} season
 * @param {Array<Player>} players
 */
function resultsText_(week, season, players) {
  const nameById = {};
  players.forEach((player) => { nameById[player.id] = player.name; });
  const byPointsDescending = (entries) => entries.slice().sort((first, second) => second.points - first.points);
  const listText = (entries) => entries.map(({ id, points }) => `${nameById[id]} ${fmtPts_(points)}`).join(', ');

  const weekEntries = players
    .filter((player) => week.byPlayer[player.id].played)
    .map((player) => ({ id: player.id, points: week.byPlayer[player.id].points }));
  const winner = week.winnerIds.length === 1 ? nameById[week.winnerIds[0]] : 'Tie';

  const isRegularSeason = week.type === GameType.REG;
  const seasonLabel = isRegularSeason ? 'Regular season' : 'Full season';
  const seasonKey = isRegularSeason ? 'regular' : 'full';
  const seasonEntries = players.map((player) => ({ id: player.id, points: season.totals[player.id][seasonKey] }));

  const weekLine = `${week.label} final: ${listText(byPointsDescending(weekEntries))}. Winner: ${winner}`;
  const seasonLine = `${seasonLabel}: ${listText(byPointsDescending(seasonEntries))}`;
  return `${weekLine}\n${seasonLine}`;
}

/** Throws on a failed post so the caller does not record it as sent. */
function postToDiscord_(webhookUrl, text) {
  // allowed_mentions with nothing to parse: a name like "@everyone" is shown, never pinged.
  const payload = JSON.stringify({ content: text, allowed_mentions: { parse: [] } });
  const options = { method: 'post', contentType: 'application/json', payload, muteHttpExceptions: true };
  const response = UrlFetchApp.fetch(webhookUrl, options);
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error(`Discord post failed: HTTP ${code}`);
}
