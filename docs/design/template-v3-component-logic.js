// v3 template component logic (data + renderVals) — source of truth for v3 scenarios/screens
<script type="text/x-dc" data-dc-script data-props="{
  &quot;$preview&quot;: {&quot;width&quot;: &quot;100%&quot;, &quot;height&quot;: 900},
  &quot;theme&quot;: {&quot;editor&quot;: &quot;enum&quot;, &quot;options&quot;: [&quot;light&quot;, &quot;dark&quot;], &quot;default&quot;: &quot;light&quot;, &quot;tsType&quot;: &quot;string&quot;, &quot;section&quot;: &quot;Appearance&quot;},
  &quot;scenario&quot;: {&quot;editor&quot;: &quot;enum&quot;, &quot;options&quot;: [&quot;normal&quot;, &quot;all-caught-up&quot;, &quot;no-team&quot;, &quot;solo&quot;, &quot;brand-new&quot;, &quot;no-projects&quot;, &quot;team-member&quot;, &quot;offline&quot;, &quot;no-api-key&quot;, &quot;signed-out&quot;], &quot;default&quot;: &quot;normal&quot;, &quot;tsType&quot;: &quot;string&quot;, &quot;section&quot;: &quot;State&quot;}
}">
class Component extends DCLogic {
  state = {
    screen: 'projects',
    theme: null,
    scenarioOverride: null,
    expandedId: 's1',
    caughtUpMap: {},
    inviteOpen: false,
    inviteCopied: false,
    inviteCode: '9KF2-XQ7',
    menuOpen: false,
    confirmDelete: false,
    roadmapOpen: false,
    roadmapState: 'idle',
    projectId: 'p1',
    paused: {},
    removed: {},
    syncing: false,
    regenerating: false,
    copiedAI: false,
    apiKey: 'sk-ant-api03-mB7v…kQ2',
    feedPerson: 'All', feedProject: 'All projects', feedTool: 'All tools',
    projFilter: 'All', projSort: 'Recent', projPerson: 'All', projIdxPerson: 'All',
    feedProjOpen: false, feedProjQuery: '',
    projMenuId: null, projConfirmId: null,
    teamSwitcherOpen: false,
    andrewRole: 'member',
    removedMembers: {},
    toast: null,
  };

  componentDidMount() { this.applyTheme(); }
  componentDidUpdate() { this.applyTheme(); }
  applyTheme() {
    const t = this.state.theme ?? this.props.theme ?? 'light';
    document.body.dataset.theme = t;
  }
  showToast(msg) {
    this.setState({ toast: msg });
    clearTimeout(this._tt);
    this._tt = setTimeout(() => this.setState({ toast: null }), 1800);
  }

  data() {
    const S = [
      { id:'s1', author:'Andrew', who:'andrew', tool:'Claude Code', project:'membridge', pid:'p1', day:'Today', time:'2h ago', wip:false,
        summary:'Shipped the unified feed API — local and teammate sessions now merge into one cursor-paginated endpoint',
        ask:'Merge the local session log and the teamsync feed into a single API the dashboard can page through. Keep ordering stable when the two machines\u2019 clocks disagree.',
        files:['server/api/feed.ts','lib/teamsync.js','lib/feed-merge.js','lib/cursor.js','test/feed-merge.test.js'],
        todos:[['Design merge cursor (lamport + wall clock)',1],['Merge iterator over both stores',1],['Cursor pagination + resume token',1],['Dedupe sessions synced from both sides',1],['Backfill test fixtures',1],['Wire dashboard to new endpoint',1]],
        checkpoints:['Settled on a hybrid cursor: lamport counter first, wall clock as tiebreaker','Wrote the two-store merge iterator; found and fixed a dupe when a session syncs from both machines','Added resume tokens so the feed can page backwards','Ported the dashboard fetch layer; deleted the old /local and /team endpoints','Full test pass, including the clock-skew fixtures'] },
      { id:'s2', author:'Andrew', who:'andrew', tool:'Codex', project:'membridge-daemon', pid:'p2', day:'Today', time:'4h ago', wip:true,
        summary:'Supabase migration — schema and auth are wired, the sync writer still points at the old store',
        ask:'Move team sync storage off the JSON blob store onto Supabase so two people can\u2019t clobber each other\u2019s writes.',
        files:['daemon/store/supabase.ts','daemon/store/schema.sql','daemon/auth.ts'],
        todos:[['Schema: teams, projects, sessions, checkpoints',1],['Row-level security per team',1],['Auth token exchange in daemon',1],['Point sync writer at Supabase',0],['Backfill existing team data',0]],
        checkpoints:['Schema drafted; sessions are append-only, checkpoints reference them','RLS policies pass the two-team isolation test','Daemon exchanges the app token for a scoped service key'] },
      { id:'s3', author:'Andrew', who:'andrew', tool:'Claude Code', project:'membridge', pid:'p1', day:'Yesterday', time:'Yesterday, 6:12 PM', wip:false,
        summary:'Fixed the distiller dropping final todo state when a session ends mid-write',
        ask:'Sessions killed mid-write lose their last todo update — the memory says 4/6 when it was really 6/6. Find it and fix it.',
        files:['daemon/distill.js','daemon/session-tail.js'],
        todos:[['Reproduce with a killed session',1],['Flush todo state on tail close',1]], checkpoints:null },
      { id:'s4', author:'Andrew', who:'andrew', tool:'Codex', project:'membridge', pid:'p1', day:'Yesterday', time:'Yesterday, 11:05 AM', wip:false,
        summary:'Sync pill now retries with backoff and surfaces daemon crashes instead of going quietly stale',
        ask:'The menubar pill sometimes shows \u201csynced\u201d hours after the daemon died. Make failure visible.',
        files:['app/menubar/pill.tsx','daemon/heartbeat.js','app/ipc.ts'],
        todos:[['Heartbeat over IPC',1],['Backoff retry',1],['Crash state in pill',1],['Click-to-restart daemon',1]], checkpoints:null },
      { id:'m1', author:'Marco', who:'marco', tool:'Claude Code', project:'membridge', pid:'p1', day:'Yesterday', time:'Yesterday, 3:12 PM', wip:false, mine:true,
        summary:'Rebuilt the catch-up ranking — sessions sort by impact score instead of pure recency',
        ask:'A one-line typo fix shouldn\u2019t outrank the feed API rewrite just because it\u2019s newer. Rank by what matters.',
        files:['lib/rank.js','lib/impact.js','test/rank.test.js'],
        todos:[['Impact score: files \u00d7 todos \u00d7 checkpoint depth',1],['Recency decay curve',1],['Pin in-progress work to top',1]], checkpoints:null },
      { id:'m2', author:'Marco', who:'marco', tool:'Claude Code', project:'membridge-site', pid:'p3', day:'Monday', time:'Mon, 4:40 PM', wip:false, mine:true,
        summary:'Drafted the landing page narrative and wired the waitlist form',
        ask:'Write the landing story around the catch-up moment, not the feature list.',
        files:['site/index.astro','site/waitlist.ts'],
        todos:[['Hero copy',1],['Waitlist endpoint',1],['OG image placeholder',1]], checkpoints:null },
    ];
    const P = [
      { id:'p1', name:'membridge', glyph:'mb', path:'~/code/membridge', shared:true, recency:0,
        lastTouched:'2h ago · Andrew',
        activeNow:false, activeLabel:'', statSessions:'11', statFiles:'38', statTodos:'2',
        todos:[{t:'Rotate the Anthropic API keys', who:'waiting on you', you:true},{t:'QA feed pagination on 1k-session projects', who:'unclaimed', you:false}] },
      { id:'p2', name:'membridge-daemon', glyph:'dm', path:'~/code/membridge-daemon', shared:true, recency:1,
        lastTouched:'4h ago · Andrew',
        activeNow:true, activeLabel:'Andrew is in a session here now', statSessions:'6', statFiles:'19', statTodos:'2',
        todos:[{t:'Point sync writer at Supabase', who:'Andrew · in progress', you:false},{t:'Backfill migration for existing teams', who:'unclaimed', you:false}] },
      { id:'p3', name:'membridge-site', glyph:'st', path:'~/code/membridge-site', shared:false, recency:2,
        lastTouched:'Mon · you',
        activeNow:false, activeLabel:'', statSessions:'2', statFiles:'5', statTodos:'0', todos:[] },
    ];
    return { S, P };
  }

  vm(s) {
    const expanded = this.state.expandedId === s.id;
    const done = s.todos.filter(t => t[1]).length;
    return {
      id: s.id, author: s.author, tool: s.tool, project: s.project, time: s.time,
      wip: s.wip, summary: s.summary, ask: s.ask, files: s.files,
      initial: s.author[0],
      color: s.who === 'marco' ? 'var(--marco)' : 'var(--andrew)',
      expanded, chev: expanded ? 'rotate(180deg)' : 'none',
      toggle: () => this.setState({ expandedId: expanded ? null : s.id }),
      hasCheckpoints: !!(s.checkpoints && s.checkpoints.length),
      checkpoints: (s.checkpoints || []).map((t, i) => ({ n: String(i + 1).padStart(2, '0'), t })),
      todoLabel: done + ' of ' + s.todos.length + ' todos done',
      todoPct: Math.round(100 * done / s.todos.length) + '%',
      todoBar: s.wip ? 'var(--amber)' : 'var(--grad)',
      todoItems: s.todos.map(([t, d]) => ({
        t, mark: d ? '✓' : '○',
        color: d ? 'var(--text3)' : 'var(--text)',
        deco: d ? 'line-through' : 'none',
      })),
    };
  }

  dayGroups(list) {
    const order = [];
    const map = {};
    list.forEach(s => {
      if (!map[s.day]) { map[s.day] = []; order.push(s.day); }
      map[s.day].push(this.vm(s));
    });
    return order.map(label => ({ label, items: map[label] }));
  }

  renderVals() {
    const { S, P } = this.data();
    const st = this.state;
    const scenario = st.scenarioOverride ?? this.props.scenario ?? 'normal';
    const isAuth = scenario === 'signed-out';
    const isOffline = scenario === 'offline';
    const noTeam = scenario === 'no-team';
    const solo = scenario === 'solo';
    const fresh = scenario === 'brand-new';
    const noProjects = scenario === 'no-projects';
    const memberView = scenario === 'team-member';
    const noKey = scenario === 'no-api-key' || !st.apiKey.trim();
    const allCaughtUp = scenario === 'all-caught-up';

    const nav = (screen) => () => this.setState({ screen, inviteOpen:false, menuOpen:false, confirmDelete:false, projMenuId:null, projConfirmId:null, teamSwitcherOpen:false });

    const navItems = [
      { label:'Projects', key:'projects', match:['projects','project'] },
      { label:'Everything', key:'feed', match:['feed'] },
      { label:'Team', key:'team', match:['team'] },
    ].map(n => {
      const active = n.match.includes(st.screen);
      return {
        label: n.label, go: nav(n.key),
        color: active ? 'var(--text)' : 'var(--text2)',
        weight: active ? '600' : '400',
        barStyle: { position:'absolute', left:0, right:0, bottom:-1, height:2, borderRadius:'1px 1px 0 0', background: active ? 'var(--grad)' : 'transparent' },
      };
    });

    // editorial filter option builder
    const opt = (val, current, setter, label) => {
      const active = val === current;
      return {
        label: label || val,
        click: () => this.setState({ [setter]: val }),
        color: active ? 'var(--text)' : 'var(--text3)',
        weight: active ? '600' : '400',
        barStyle: { position:'absolute', left:0, right:0, bottom:0, height:2, borderRadius:1, background: active ? 'var(--grad)' : 'transparent' },
      };
    };

    const feedPersonOptions = ['All','Marco','Andrew'].map(v => opt(v, st.feedPerson, 'feedPerson'));
    const feedToolOptions = ['All tools','Claude Code','Codex'].map(v => opt(v, st.feedTool, 'feedTool', v === 'All tools' ? 'All' : v));
    const allProjNames = ['All projects', ...P.filter(p => !st.removed[p.id]).map(p => p.name)];
    const q = st.feedProjQuery.trim().toLowerCase();
    const feedProjectOptions = allProjNames
      .filter(n => !q || n === 'All projects' || n.toLowerCase().includes(q))
      .map(n => {
        const active = st.feedProject === n;
        return {
          label: n === 'All projects' ? 'All projects' : n,
          count: n === 'All projects' ? S.length : S.filter(s => s.project === n).length,
          color: active ? 'var(--text)' : 'var(--text2)',
          weight: active ? '600' : '400',
          check: active ? '✓' : '',
          click: () => this.setState({ feedProject: n, feedProjOpen: false, feedProjQuery: '' }),
        };
      });
    const feedList = S.filter(s =>
      (st.feedPerson === 'All' || s.author === st.feedPerson) &&
      (st.feedProject === 'All projects' || s.project === st.feedProject) &&
      (st.feedTool === 'All tools' || s.tool === st.feedTool));

    // projects index
    const soloize = (p) => solo ? { ...p, shared:false, lastTouched: p.lastTouched.replace('Andrew','you'), activeNow:false, todos: p.todos.filter(t => t.you) } : p;
    const projectsEmpty = noProjects || fresh;
    const newCount = (pid) => (solo || isOffline) ? 0 : S.filter(s => s.pid === pid && !s.mine).length;
    const isCaughtUp = (pid) => allCaughtUp || !!st.caughtUpMap[pid];

    const visible = P.map(soloize).filter(p => !st.removed[p.id])
      .filter(p => st.projFilter === 'All' || (st.projFilter === 'Shared' ? p.shared : !p.shared))
      .filter(p => st.projIdxPerson === 'All' || S.some(s => s.pid === p.id && s.author === st.projIdxPerson));
    const sorted = st.projSort === 'Name' ? [...visible].sort((a,b) => a.name.localeCompare(b.name)) : [...visible].sort((a,b) => a.recency - b.recency);
    const projIndexRows = sorted.map(p => {
      const menuOpen = st.projMenuId === p.id;
      const confirming = st.projConfirmId === p.id;
      const n = newCount(p.id);
      const open = () => this.setState({ screen:'project', projectId:p.id, projMenuId:null, roadmapOpen:false, roadmapState:'idle' });
      return {
        ...p,
        badge: p.shared ? 'shared · membridge-core' : 'local only',
        pausedFlag: !!st.paused[p.id],
        hasNew: n > 0 && !isCaughtUp(p.id),
        newLabel: n + (n === 1 ? ' new session' : ' new sessions') + ' since you last looked',
        menuOpen, confirming, notConfirming: !confirming,
        toggleMenu: () => this.setState({ projMenuId: menuOpen ? null : p.id, projConfirmId:null }),
        open,
        openRoadmap: () => { open(); this.setState({ roadmapOpen:true }); },
        pauseLabel: st.paused[p.id] ? 'Resume watching' : 'Pause watching',
        togglePause: () => this.setState(s2 => ({ paused: { ...s2.paused, [p.id]: !s2.paused[p.id] }, projMenuId:null })),
        askDelete: () => this.setState({ projConfirmId: p.id }),
        cancelDelete: () => this.setState({ projConfirmId: null }),
        doDelete: () => { this.setState(s2 => ({ removed: { ...s2.removed, [p.id]: true }, projMenuId:null, projConfirmId:null })); this.showToast('Project and its team memory deleted'); },
      };
    });
    const projFilterGroups = [
      { label:'show', options:['All','Shared','Local'].map(v => opt(v, st.projFilter, 'projFilter')) },
      { label:'person', options:['All','Marco','Andrew'].map(v => opt(v, st.projIdxPerson, 'projIdxPerson')) },
      { label:'sort', options:['Recent','Name'].map(v => opt(v, st.projSort, 'projSort')) },
    ];
    const totalNew = P.filter(p => !st.removed[p.id]).reduce((a,p) => a + (isCaughtUp(p.id) ? 0 : newCount(p.id)), 0);
    const projectsSubline = projectsEmpty ? 'Nothing watched yet' :
      isOffline ? 'Offline — teammate activity paused' :
      solo ? '3 projects, all local' :
      totalNew > 0 ? totalNew + ' new sessions from Andrew across your projects' : 'All caught up across your projects';

    // team
    const isOwner = !memberView;
    const membersData = [
      { name:'Marco', who:'marco', you:true, role: memberView ? 'member' : 'owner', joined:'March 2026', activeNow:false, lastSeen:'now — that\u2019s you' },
      { name:'Andrew', who:'andrew', you:false, role: memberView ? 'owner' : st.andrewRole, joined:'March 2026', activeNow:true, activeIn:'membridge-daemon' },
    ].filter(m => !st.removedMembers[m.name]);
    const members = membersData.map(m => {
      const owner = m.role === 'owner';
      return {
        name: m.name, initial: m.name[0],
        color: m.who === 'marco' ? 'var(--marco)' : 'var(--andrew)',
        youLabel: m.you ? '· you' : '',
        joined: m.joined,
        activeNow: !!m.activeNow, notActive: !m.activeNow,
        activeIn: m.activeIn || '', lastSeen: m.lastSeen || '2h ago',
        role: m.role,
        roleColor: owner ? 'var(--accent)' : 'var(--text3)',
        roleBorder: owner ? 'var(--accent-brd)' : 'var(--border)',
        roleBg: owner ? 'var(--accent-soft)' : 'transparent',
        showControls: isOwner && !m.you,
        roleAction: m.role === 'owner' ? 'Make member' : 'Make owner',
        changeRole: () => { this.setState({ andrewRole: m.role === 'owner' ? 'member' : 'owner' }); this.showToast(m.name + ' is now ' + (m.role === 'owner' ? 'a member' : 'an owner')); },
        removeLabel: 'Remove',
        remove: () => { this.setState(s2 => ({ removedMembers: { ...s2.removedMembers, [m.name]: true } })); this.showToast(m.name + ' removed from membridge-core'); },
      };
    });

    // project page
    const proj = P.map(soloize).find(p => p.id === st.projectId) || P[0];
    const projHistoryList = S.filter(s => s.pid === proj.id && (st.projPerson === 'All' || s.author === st.projPerson));
    const projGroups = this.dayGroups(projHistoryList);
    const projNewSessions = (solo || isOffline) ? [] : S.filter(s => s.pid === proj.id && !s.mine);
    const projCaughtUp = isCaughtUp(proj.id) || projNewSessions.length === 0;
    const projHeadlines = projNewSessions.map(s => this.vm(s));

    const settingsProjects = P.filter(p => !st.removed[p.id]).map(p => ({
      name: p.name,
      path: p.path,
      badge: p.shared && !solo ? 'shared' : 'local only',
      pauseLabel: st.paused[p.id] ? 'Resume' : 'Pause',
      togglePause: () => this.setState(s2 => ({ paused: { ...s2.paused, [p.id]: !s2.paused[p.id] } })),
      removeLabel: st.confirmDelete === p.id ? 'Really delete?' : 'Delete',
      remove: () => {
        if (st.confirmDelete === p.id) { this.setState(s2 => ({ removed: { ...s2.removed, [p.id]: true }, confirmDelete:false })); this.showToast('Project removed for the whole team'); }
        else this.setState({ confirmDelete: p.id });
      },
    }));

    const theme = st.theme ?? this.props.theme ?? 'light';

    return {
      isAuth, isApp: !isAuth,
      isProjects: st.screen === 'projects',
      isFeed: st.screen === 'feed',
      isTeam: st.screen === 'team',
      isProject: st.screen === 'project',
      isSettings: st.screen === 'settings',
      navItems,
      settingsBorder: st.screen === 'settings' ? 'var(--accent-brd)' : 'var(--border)',
      navProjects: nav('projects'), navFeed: nav('feed'), navTeam: nav('team'), navSettings: nav('settings'),
      signIn: () => this.setState({ scenarioOverride: 'normal', screen: 'projects' }),
      logOut: () => this.setState({ scenarioOverride: 'signed-out' }),
      themeGlyph: theme === 'dark' ? '☀' : '☾',
      toggleTheme: () => this.setState({ theme: theme === 'dark' ? 'light' : 'dark' }),

      syncLabel: isOffline ? 'Offline' : (st.syncing ? 'Syncing' : 'Synced'),
      syncDotStyle: {
        width:7, height:7, borderRadius:'50%', flex:'none',
        background: isOffline ? 'var(--amber)' : 'var(--green)',
        animation: st.syncing ? 'mbPulse .8s ease infinite' : 'mbPulse 3s ease infinite',
      },
      syncNow: () => {
        if (isOffline) { this.showToast('Still unreachable — retrying in the background'); return; }
        this.setState({ syncing:true });
        setTimeout(() => this.setState({ syncing:false }), 1200);
      },

      inviteOpen: st.inviteOpen,
      toggleInvite: () => this.setState(s2 => ({ inviteOpen: !s2.inviteOpen, inviteCopied:false })),
      inviteCopyLabel: st.inviteCopied ? 'Copied' : 'Copy',
      inviteCode: st.inviteCode || '—',
      copyInvite: () => { try { navigator.clipboard.writeText(st.inviteCode); } catch(e){} this.setState({ inviteCopied:true }); },

      isOffline,

      // projects index
      hasProjects: !projectsEmpty,
      projectsEmpty,
      projectsSubline,
      isSoloProjects: solo && !projectsEmpty,
      projFilterGroups,
      projIndexRows,
      addProjectToast: () => this.showToast('Would open the folder picker'),

      // feed
      feedPersonOptions,
      feedToolOptions,
      feedProjectOptions,
      feedProjNoMatch: feedProjectOptions.length <= 1 && !!q,
      feedProjOpen: st.feedProjOpen,
      toggleFeedProj: () => this.setState(s2 => ({ feedProjOpen: !s2.feedProjOpen, feedProjQuery: '' })),
      feedProjQuery: st.feedProjQuery,
      onFeedProjQuery: (e) => this.setState({ feedProjQuery: e.target.value }),
      feedProjTriggerLabel: st.feedProject === 'All projects' ? 'All' : st.feedProject,
      feedProjTriggerColor: st.feedProject === 'All projects' ? 'var(--text3)' : 'var(--text)',
      feedProjTriggerWeight: st.feedProject === 'All projects' ? '400' : '600',
      feedProjTriggerBar: { position:'absolute', left:0, right:0, bottom:0, height:2, borderRadius:1, background: st.feedProject === 'All projects' ? 'transparent' : 'var(--grad)' },
      feedGroups: this.dayGroups(feedList),

      // team
      teamNone: noTeam || solo || fresh,
      teamSome: !(noTeam || solo || fresh),
      isOwner,
      isMemberView: memberView,
      myRoleLabel: memberView ? 'a member' : 'the owner',
      memberCountLabel: members.length + (members.length === 1 ? ' member' : ' members'),
      members,
      teamSwitcherOpen: st.teamSwitcherOpen,
      toggleTeamSwitcher: () => this.setState(s2 => ({ teamSwitcherOpen: !s2.teamSwitcherOpen })),
      switchTeamToast: () => { this.setState({ teamSwitcherOpen:false }); this.showToast('Would switch teams'); },
      renameToast: () => this.showToast('Would rename the team'),
      leaveToast: () => this.showToast('Would leave membridge-core'),
      createTeamToast: () => this.showToast('Would create or join a team'),
      hasJoinCode: !!st.inviteCode,
      noJoinCode: !st.inviteCode,
      regenCode: () => {
        const c = () => Math.random().toString(36).slice(2, 6).toUpperCase();
        this.setState({ inviteCode: c() + '-' + c().slice(0,3), inviteCopied:false });
        this.showToast('New join code — the old one no longer works');
      },
      revokeCode: () => { this.setState({ inviteCode: null }); this.showToast('Join code revoked'); },

      // project page catch-up
      proj,
      projGroups,
      projPersonOptions: ['All','Marco','Andrew'].map(v => opt(v, st.projPerson, 'projPerson')),
      projPersonFilter: st.projPerson,
      projHistoryEmpty: projHistoryList.length === 0,
      isProjP1: proj.id === 'p1',
      isProjP2: proj.id === 'p2',
      lastViewedLabel: 'yesterday, 3:40 PM',
      showAnchorLine: !projCaughtUp,
      showMarkCaughtUp: !projCaughtUp && !isOffline,
      markCaughtUp: () => { this.setState(s2 => ({ caughtUpMap: { ...s2.caughtUpMap, [proj.id]: true } })); this.showToast('Marked as caught up'); },
      undoCaughtUp: () => this.setState(s2 => ({ caughtUpMap: { ...s2.caughtUpMap, [proj.id]: false } })),
      canUndoCaughtUp: !!st.caughtUpMap[proj.id],
      projCaughtUp,
      caughtUpSub: st.caughtUpMap[proj.id] ? 'Marked just now. New sessions will collect here as Andrew works.' : (solo ? 'This project is local only — only your own sessions land here.' : 'Nothing new since ' + proj.lastTouched.toLowerCase() + '.'),
      showProjCatchupBody: !projCaughtUp,
      showBriefing: !noKey && !isOffline && !projCaughtUp && proj.shared,
      showNoKeyHint: noKey && !isOffline && !projCaughtUp,
      briefingOpacity: st.regenerating ? 0.35 : 1,
      regenLabel: st.regenerating ? 'Thinking…' : 'Regenerate',
      regenStyle: { display:'inline-block', animation: st.regenerating ? 'mbSpin .8s linear infinite' : 'none' },
      regenerate: () => { this.setState({ regenerating:true }); setTimeout(() => this.setState({ regenerating:false }), 1100); },
      projHeadlines,
      projHasTodos: proj.todos.length > 0 && !projCaughtUp,
      projTodos: proj.todos.map(t => ({ t: t.t, who: t.who, whoColor: t.you ? 'var(--amber)' : 'var(--text3)' })),

      projPaused: !!st.paused[proj.id],
      pauseLabel: st.paused[proj.id] ? 'Resume watching' : 'Pause watching',
      togglePause: () => this.setState(s2 => ({ paused: { ...s2.paused, [proj.id]: !s2.paused[proj.id] }, menuOpen:false })),
      menuOpen: st.menuOpen,
      toggleMenu: () => this.setState(s2 => ({ menuOpen: !s2.menuOpen, confirmDelete:false })),
      menuClose: () => this.setState({ menuOpen:false }),
      confirmingDelete: st.confirmDelete === true,
      notConfirmingDelete: st.confirmDelete !== true,
      askDelete: () => this.setState({ confirmDelete:true }),
      cancelDelete: () => this.setState({ confirmDelete:false }),
      doDelete: () => { this.setState({ menuOpen:false, confirmDelete:false, screen:'projects' }); this.showToast('Project and its team memory deleted'); },
      copyAiLabel: st.copiedAI ? 'Copied ✓' : 'Copy for AI',
      copyForAI: () => {
        try { navigator.clipboard.writeText('# ' + proj.name + ' — MemBridge context\n\nRecent sessions, state and open todos…'); } catch(e){}
        this.setState({ copiedAI:true }); this.showToast('Project context copied — paste into any AI tool');
        setTimeout(() => this.setState({ copiedAI:false }), 1800);
      },
      roadmapOpen: st.roadmapOpen,
      roadmapChev: st.roadmapOpen ? 'rotate(90deg)' : 'none',
      toggleRoadmap: () => this.setState(s2 => ({ roadmapOpen: !s2.roadmapOpen })),
      roadmapIdle: st.roadmapState === 'idle',
      roadmapLoading: st.roadmapState === 'loading',
      roadmapDone: st.roadmapState === 'done',
      genRoadmap: () => { this.setState({ roadmapState:'loading' }); setTimeout(() => this.setState({ roadmapState:'done' }), 1400); },

      settingsProjects,
      apiKey: st.apiKey,
      onApiKey: (e) => this.setState({ apiKey: e.target.value }),
      keyStatus: st.apiKey.trim() ? 'active' : 'no key',
      keyStatusColor: st.apiKey.trim() ? 'var(--green)' : 'var(--text3)',

      toast: st.toast,
    };
  }
}
</script>