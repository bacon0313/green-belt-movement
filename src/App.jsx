import { useEffect, useMemo, useRef, useState } from 'react'
import {
  onValue,
  push,
  ref,
  runTransaction,
  serverTimestamp,
  set,
  update,
} from 'firebase/database'
import { AlertTriangle, ArrowRight, Leaf, Monitor, RotateCcw, Sprout, Users } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { database, isFirebaseConfigured } from './firebaseConfig'
import { LanguageProvider, useLanguage } from './LanguageContext'

const HOST_PIN = '2026'

const DEFAULT_INDICATORS = {
  forestHealth: 30,
  environmentalAwareness: 30,
  communityParticipation: 30,
  publicSupport: 30,
}

const DEFAULT_PHASE1_STATE = {
  substage: 'WAVE_1',
  allowRoleSwitch: false,
  boostExpiresAt: 0,
  roleLimits: {
    'Tree Planter': 2,
    'Community Organizer': 2,
    'Publicity Campaigner': 2,
  },
  roleCounts: {
    Observer: 0,
    'Tree Planter': 0,
    'Community Organizer': 0,
    'Publicity Campaigner': 0,
  },
  townHallPaused: false,
  momentumBoost: { active: false, endsAt: 0 },
  bulldozer: { active: false, truthExposes: 0, lastTickAt: 0 },
  solutionCards: {
    'water-shortage': false,
    'no-firewood': false,
    'soil-erosion': false,
  },
}

const DEFAULT_ROLE_LEVELS = {
  planterLevel: 1,
  planterProgress: 0,
  organizerLevel: 1,
  organizerProgress: 0,
  campaignerLevel: 1,
  campaignerProgress: 0,
}

const DEFAULT_ORGANIZATION_AP = {
  observerAP: 0,
  planterAP: 0,
  organizerAP: 0,
  campaignerAP: 0,
}
const AP_MODEL_VERSION = 2

const DEFAULT_UPGRADES = {
  planterTools: { level: 0, progress: 0 },
  planterIrrigation: { level: 0, progress: 0 },
  planterFertilization: { level: 0, progress: 0 },
  campaignerMegaphone: { level: 0, progress: 0 },
  campaignerNetwork: { level: 0, progress: 0 },
  campaignerMedia: { level: 0, progress: 0 },
  organizerGreenhouse: { level: 0, progress: 0 },
  organizerPact: { level: 0, progress: 0 },
  organizerSeedBank: { level: 0, progress: 0 },
}

const DEFAULT_EMERGENCY_EVENT = {
  active: false,
  resolved: null,
  endsAt: 0,
  shieldClicks: 0,
  targetClicks: 80,
  targetColor: null,
}
const DEFAULT_GOALS = { trees: 1500, petitions: 12000 }
const MIN_ACTION_COOLDOWN_MS = 2000

function mergeRoleLevels(value) {
  return { ...DEFAULT_ROLE_LEVELS, ...(value || {}) }
}

function mergeOrganizationAP(value) {
  return { ...DEFAULT_ORGANIZATION_AP, ...(value || {}) }
}

function mergeUpgrades(value) {
  return Object.fromEntries(Object.keys(DEFAULT_UPGRADES).map((key) => [
    key,
    { ...DEFAULT_UPGRADES[key], ...(value?.[key] || {}) },
  ]))
}

function mergeEmergencyEvent(value) {
  return { ...DEFAULT_EMERGENCY_EVENT, ...(value || {}) }
}

function vibrateDevice() {
  if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(40)
}

function getActionCooldownMs(baseCooldownMs, boostActive = false) {
  const scaledCooldown = boostActive ? Math.round(baseCooldownMs * 0.7) : baseCooldownMs
  return Math.max(MIN_ACTION_COOLDOWN_MS, scaledCooldown)
}

function mergeGoals(value) {
  return {
    trees: Math.max(1, Number(value?.trees) || DEFAULT_GOALS.trees),
    petitions: Math.max(1, Number(value?.petitions) || DEFAULT_GOALS.petitions),
  }
}

function normalizeNickname(nickname) {
  return String(nickname || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

async function getOrCreateDeviceTokenHash() {
  const storageKey = 'gbm-device-token'
  let token = window.localStorage.getItem(storageKey)
  if (!token) {
    token = window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    window.localStorage.setItem(storageKey, token)
  }
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const DEFAULT_GAME_STATE = {
  apModelVersion: AP_MODEL_VERSION,
  phase: 'LOBBY',
  resetAt: 0,
  endingAt: 0,
  trees: 0,
  seeds: 100,
  sharedSeeds: 100,
  petitions: 0,
  goals: DEFAULT_GOALS,
  players: {},
  rally: { active: false, endsAt: 0 },
  activityFeed: {},
  roleLevels: DEFAULT_ROLE_LEVELS,
  organizationAP: DEFAULT_ORGANIZATION_AP,
  upgrades: DEFAULT_UPGRADES,
  emergency: DEFAULT_EMERGENCY_EVENT,
  oppositionEvent: null,
  phase1: DEFAULT_PHASE1_STATE,
  phase2Event: null,
  indicators: DEFAULT_INDICATORS,
  roundAllocations: {},
  roundResults: {},
}

const PHASE_1_SUBSTAGES = ['WAVE_1', 'WAVE_2', 'WAVE_3']
const PHASE1_WAVE_RULES = {
  WAVE_1: { actionCooldownMs: 5000, campaignCooldownMs: 5000, roleLimit: 2, treeYield: 1, megaRallyUnlocked: false },
  WAVE_2: { actionCooldownMs: 3500, campaignCooldownMs: 3500, roleLimit: 6, treeYield: 2, megaRallyUnlocked: false },
  WAVE_3: { actionCooldownMs: 2500, campaignCooldownMs: 2500, roleLimit: 15, treeYield: 1, megaRallyUnlocked: true },
}
const ROLE_UPGRADE_FLOWS = {
  'Community Organizer': { levelKey: 'planterLevel', progressKey: 'planterProgress', targetKey: 'planters' },
  'Tree Planter': { levelKey: 'campaignerLevel', progressKey: 'campaignerProgress', targetKey: 'campaigners' },
  'Publicity Campaigner': { levelKey: 'organizerLevel', progressKey: 'organizerProgress', targetKey: 'organizers' },
}
const ROLE_AP_KEYS = {
  Observer: 'observerAP',
  'Community Organizer': 'organizerAP',
  'Tree Planter': 'planterAP',
  'Publicity Campaigner': 'campaignerAP',
}

function migratePlayerAPToGroups(players, value) {
  const organizationAP = mergeOrganizationAP(value)
  const nextPlayers = {}
  Object.entries(players || {}).forEach(([playerId, player]) => {
    const playerData = { ...(player || {}) }
    const apKey = ROLE_AP_KEYS[playerData.role]
    if (apKey) organizationAP[apKey] += Number(playerData.actionPoints || 0)
    delete playerData.actionPoints
    nextPlayers[playerId] = playerData
  })
  return { organizationAP, players: nextPlayers }
}

function adjustRoleAP(value, role, amount) {
  const apKey = ROLE_AP_KEYS[role]
  const organizationAP = mergeOrganizationAP(value)
  if (!apKey) return organizationAP
  return {
    ...organizationAP,
    [apKey]: Math.max(0, Number(organizationAP[apKey] || 0) + amount),
  }
}

const SURVIVAL_SITUATIONS = [
  { id: 'water-shortage', titleKey: 'waterShortage' },
  { id: 'no-firewood', titleKey: 'noFirewood' },
  { id: 'soil-erosion', titleKey: 'soilErosion' },
]
const OBSERVER_NEEDS = [
  { id: 'WATER', titleKey: 'needWater' },
  { id: 'FIREWOOD', titleKey: 'needFirewood' },
  { id: 'PARK', titleKey: 'needPark' },
]
const HISTORY_TRIVIA = [
  { id: 'main-action', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'tree-benefits', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'public-space', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'public-decisions', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'movement-growth', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'protect-parks', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'cut-trees', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'organizers', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'persuade-observers', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'petition', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'origin', answer: 'A', options: ['A', 'B', 'C', 'D'] },
  { id: 'collective-action', answer: 'A', options: ['A', 'B', 'C', 'D'] },
]

function drawHistoryQuestion(usedIds = [], lastId = '') {
  const unused = HISTORY_TRIVIA.filter((question) => !usedIds.includes(question.id) && question.id !== lastId)
  const pool = unused.length > 0
    ? unused
    : HISTORY_TRIVIA.filter((question) => question.id !== lastId)
  return pool[Math.floor(Math.random() * pool.length)]
}

const PHASE_2_PHASES = ['PHASE_2_ROUND_1', 'PHASE_2_ROUND_2', 'PHASE_2_ROUND_3']
const ALLOCATION_ITEMS = [
  { id: 'plantTrees', labelKey: 'plantTrees' },
  { id: 'protectForest', labelKey: 'protectForest' },
  { id: 'educationCampaign', labelKey: 'educationCampaign' },
  { id: 'organizeCommunity', labelKey: 'organizeCommunity' },
  { id: 'signPetition', labelKey: 'signPetition' },
]
const INDICATOR_KEYS = ['forestHealth', 'environmentalAwareness', 'communityParticipation', 'publicSupport']
const ACTION_EFFECTS = {
  plantTrees: { forestHealth: 2, communityParticipation: 1 },
  protectForest: { forestHealth: 2, environmentalAwareness: 1 },
  educationCampaign: { environmentalAwareness: 2, publicSupport: 1 },
  organizeCommunity: { communityParticipation: 2, publicSupport: 1 },
  signPetition: { publicSupport: 2, communityParticipation: 1 },
}
const PHASE_2_EVENTS = [
  {
    id: 'drought',
    titleKey: 'drought',
    descriptionKey: 'droughtDescription',
    effects: { forestHealth: 0.7 },
  },
  {
    id: 'lack-of-funding',
    titleKey: 'lackOfFunding',
    descriptionKey: 'lackOfFundingDescription',
    effects: { environmentalAwareness: 0.8, publicSupport: 0.8 },
  },
  {
    id: 'community-disagreement',
    titleKey: 'communityDisagreement',
    descriptionKey: 'communityDisagreementDescription',
    effects: { communityParticipation: 0.6 },
  },
  {
    id: 'public-awareness-campaign',
    titleKey: 'publicAwarenessCampaign',
    descriptionKey: 'publicAwarenessCampaignDescription',
    effects: { publicSupport: 1.5 },
  },
]
const ROLES = [
  { id: 'Observer', description: 'Watch the movement and choose your moment to act.' },
  { id: 'Tree Planter', description: 'Plant trees and grow the green belt.' },
  { id: 'Community Organizer', description: 'Launch a rally to boost everyone.' },
  { id: 'Publicity Campaigner', description: 'Give speeches and gather signatures.' },
]

const OPPOSITION_EVENTS = [
  { id: 'deforestation', label: 'Deforestation Alert', message: 'A new road is threatening the forest.', impact: 'trees', ratio: 0.1 },
  { id: 'misinformation', label: 'Misinformation Wave', message: 'False claims are spreading through the community.', impact: 'petitions', ratio: 0.1 },
  { id: 'political-pressure', label: 'Political Pressure', message: 'Opposition leaders are trying to silence the movement.', impact: 'both', ratio: 0.05 },
]

const EVENT_TRANSLATIONS = {
  'Deforestation Alert': ['admin.deforestation', 'events.deforestationMessage'],
  'Misinformation Wave': ['admin.misinformation', 'events.misinformationMessage'],
  'Political Pressure': ['admin.politicalPressure', 'events.politicalPressureMessage'],
}

function useGameState() {
  const { t } = useLanguage()
  const translationRef = useRef(t)
  const [gameState, setGameState] = useState(DEFAULT_GAME_STATE)
  const [connectionError, setConnectionError] = useState('')

  useEffect(() => {
    translationRef.current = t
  }, [t])

  useEffect(() => {
    if (!database) return undefined

    const gameStateRef = ref(database, 'gameState')
    const unsubscribe = onValue(
      gameStateRef,
      (snapshot) => {
        const value = snapshot.val() || {}
        setGameState({
          ...DEFAULT_GAME_STATE,
          ...value,
          seeds: value.sharedSeeds ?? value.seeds ?? DEFAULT_GAME_STATE.seeds,
          sharedSeeds: value.sharedSeeds ?? value.seeds ?? DEFAULT_GAME_STATE.sharedSeeds,
          goals: mergeGoals(value.goals),
          players: value.players || {},
          activityFeed: value.activityFeed || {},
          roleLevels: mergeRoleLevels(value.roleLevels),
          organizationAP: mergeOrganizationAP(value.organizationAP),
          upgrades: mergeUpgrades(value.upgrades),
          emergency: mergeEmergencyEvent(value.emergency),
          rally: { ...DEFAULT_GAME_STATE.rally, ...(value.rally || {}) },
          phase1: {
            ...DEFAULT_PHASE1_STATE,
            ...(value.phase1 || {}),
            roleLimits: { ...DEFAULT_PHASE1_STATE.roleLimits, ...(value.phase1?.roleLimits || {}) },
            roleCounts: { ...DEFAULT_PHASE1_STATE.roleCounts, ...(value.phase1?.roleCounts || {}) },
            momentumBoost: { ...DEFAULT_PHASE1_STATE.momentumBoost, ...(value.phase1?.momentumBoost || {}) },
            bulldozer: { ...DEFAULT_PHASE1_STATE.bulldozer, ...(value.phase1?.bulldozer || {}) },
            solutionCards: { ...DEFAULT_PHASE1_STATE.solutionCards, ...(value.phase1?.solutionCards || {}) },
          },
          indicators: { ...DEFAULT_INDICATORS, ...(value.indicators || {}) },
          roundAllocations: value.roundAllocations || {},
          roundResults: value.roundResults || {},
        })
        setConnectionError('')
      },
      (error) => setConnectionError(`${translationRef.current('common.unableToRead')}: ${error.message}`),
    )

    runTransaction(gameStateRef, (current) => {
      if (!current) return DEFAULT_GAME_STATE
      const migrated = current.apModelVersion === AP_MODEL_VERSION
        ? { organizationAP: mergeOrganizationAP(current.organizationAP), players: current.players || {} }
        : migratePlayerAPToGroups(current.players, current.organizationAP)
      return {
          ...current,
          seeds: current.sharedSeeds ?? current.seeds ?? DEFAULT_GAME_STATE.sharedSeeds,
          sharedSeeds: current.sharedSeeds ?? current.seeds ?? DEFAULT_GAME_STATE.sharedSeeds,
          goals: mergeGoals(current.goals),
          roleLevels: mergeRoleLevels(current.roleLevels),
          apModelVersion: AP_MODEL_VERSION,
          organizationAP: migrated.organizationAP,
          players: migrated.players,
          upgrades: mergeUpgrades(current.upgrades),
          emergency: mergeEmergencyEvent(current.emergency),
          phase1: {
            ...DEFAULT_PHASE1_STATE,
            ...(current.phase1 || {}),
            roleLimits: { ...DEFAULT_PHASE1_STATE.roleLimits, ...(current.phase1?.roleLimits || {}) },
            roleCounts: { ...DEFAULT_PHASE1_STATE.roleCounts, ...(current.phase1?.roleCounts || {}) },
            momentumBoost: { ...DEFAULT_PHASE1_STATE.momentumBoost, ...(current.phase1?.momentumBoost || {}) },
            bulldozer: { ...DEFAULT_PHASE1_STATE.bulldozer, ...(current.phase1?.bulldozer || {}) },
            solutionCards: { ...DEFAULT_PHASE1_STATE.solutionCards, ...(current.phase1?.solutionCards || {}) },
          },
          indicators: current.indicators || DEFAULT_INDICATORS,
          roundAllocations: current.roundAllocations || {},
          roundResults: current.roundResults || {},
        }
    }).catch((error) => {
      setConnectionError(`${translationRef.current('common.unableToInitialize')}: ${error.message}`)
    })

    return unsubscribe
  }, [])

  return { gameState, connectionError }
}

function useRallyCountdown(rally) {
  const [now, setNow] = useState(Date.now())
  const remaining = rally?.active ? Math.max(0, Math.ceil((rally.endsAt - now) / 1000)) : 0

  useEffect(() => {
    if (!rally?.active || !rally.endsAt) return undefined
    const expire = () => {
      if (!database) return
      runTransaction(ref(database, 'gameState/rally'), (current) => {
        if (!current?.active || Number(current.endsAt) !== Number(rally.endsAt) || Date.now() < Number(current.endsAt)) return undefined
        return { ...current, active: false }
      }).catch((error) => console.error('Unable to expire community boost:', error))
    }
    if (Date.now() >= Number(rally.endsAt)) {
      setNow(Date.now())
      expire()
      return undefined
    }
    const timer = window.setInterval(() => {
      const currentTime = Date.now()
      setNow(currentTime)
      if (currentTime < Number(rally.endsAt)) return
      window.clearInterval(timer)
      expire()
    }, 250)
    return () => window.clearInterval(timer)
  }, [rally?.active, rally?.endsAt])

  useEffect(() => {
    if (!rally?.active) setNow(Date.now())
    return undefined
  }, [rally?.active])

  return remaining
}

function useMomentumCountdown(momentumBoost) {
  const [now, setNow] = useState(Date.now())
  const remaining = momentumBoost?.active ? Math.max(0, Math.ceil((momentumBoost.endsAt - now) / 1000)) : 0

  useEffect(() => {
    if (!momentumBoost?.active || !momentumBoost.endsAt) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [momentumBoost?.active, momentumBoost?.endsAt])

  useEffect(() => {
    if (!database || !momentumBoost?.active || !momentumBoost.endsAt || momentumBoost.endsAt > Date.now()) return undefined
    update(ref(database, 'gameState/phase1/momentumBoost'), { active: false }).catch(() => {})
    return undefined
  }, [momentumBoost?.active, momentumBoost?.endsAt])

  return remaining
}

function useCountdownUntil(until) {
  const [now, setNow] = useState(Date.now())
  const remaining = Math.max(0, Math.ceil((Number(until || 0) - now) / 1000))

  useEffect(() => {
    if (!until || until <= Date.now()) return undefined
    const timer = window.setInterval(() => {
      const currentTime = Date.now()
      setNow(currentTime)
      if (currentTime >= Number(until)) window.clearInterval(timer)
    }, 250)
    return () => window.clearInterval(timer)
  }, [until])

  return remaining
}

function useEmergencyResolution(emergency) {
  useEffect(() => {
    if (!database || !emergency?.active || !emergency.endsAt) return undefined
    let timer
    const expire = () => {
      const remaining = Number(emergency.endsAt) - Date.now()
      if (remaining > 0) {
        timer = window.setTimeout(expire, remaining)
        return
      }
      runTransaction(ref(database, 'gameState'), (current) => {
        const event = mergeEmergencyEvent(current?.emergency)
        if (current?.phase !== 'PHASE_1' || !event.active || Date.now() < Number(event.endsAt)) return undefined
        if (Number(event.shieldClicks || 0) >= 80) {
          return { ...current, emergency: { ...event, active: false, resolved: 'success' } }
        }

        const pactLevel = Number(mergeUpgrades(current.upgrades).organizerPact.level || 0)
        const treeLoss = Math.max(50, 150 - pactLevel * 25)
        return {
          ...current,
          trees: Math.max(0, Number(current.trees || 0) - treeLoss),
          emergency: { ...event, active: false, resolved: 'failed' },
        }
      }).catch((error) => console.error('Unable to resolve emergency:', error))
    }

    timer = window.setTimeout(expire, Math.max(0, Number(emergency.endsAt) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [emergency?.active, emergency?.endsAt])
}

function usePhase1AutoFinish(gameState) {
  useEffect(() => {
    if (!database || gameState.phase !== 'PHASE_1') return undefined

    const finishIfReady = () => runTransaction(ref(database, 'gameState'), (current) => {
      if (current?.phase !== 'PHASE_1') return undefined
      const goals = mergeGoals(current.goals)
      const goalsReached = Number(current.trees || 0) >= goals.trees
        && Number(current.petitions || 0) >= goals.petitions
      const endingAt = Number(current.endingAt || 0)
      if (!goalsReached && (!endingAt || Date.now() < endingAt)) return undefined
      return {
        ...current,
        phase: 'FINISHED',
        finishedAt: Date.now(),
        endingAt: 0,
        rally: { ...(current.rally || {}), active: false },
        emergency: { ...mergeEmergencyEvent(current.emergency), active: false },
        phase1: {
          ...current.phase1,
          boostExpiresAt: 0,
          bulldozer: { ...current.phase1?.bulldozer, active: false },
        },
      }
    }).catch((error) => console.error('Unable to finish Phase 1:', error))

    const goals = mergeGoals(gameState.goals)
    if (Number(gameState.trees || 0) >= goals.trees && Number(gameState.petitions || 0) >= goals.petitions) {
      finishIfReady()
      return undefined
    }

    const endingAt = Number(gameState.endingAt || 0)
    if (!endingAt) return undefined
    const timer = window.setTimeout(finishIfReady, Math.max(0, endingAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [gameState.phase, gameState.endingAt, gameState.trees, gameState.petitions, gameState.goals])
}

function useSeedBank(upgrades) {
  useEffect(() => {
    if (!database) return undefined
    const level = Number(upgrades?.organizerSeedBank?.level || 0)
    if (level <= 0) return undefined
    const timer = window.setInterval(() => {
      runTransaction(ref(database, 'gameState'), (current) => {
        if (!current) return current
        const activeLevel = Number(mergeUpgrades(current.upgrades).organizerSeedBank.level || 0)
        if (activeLevel <= 0) return current
        const seeds = Number(current.sharedSeeds ?? current.seeds ?? 0) + activeLevel * 2
        return { ...current, seeds, sharedSeeds: seeds }
      }).catch(() => {})
    }, 10000)
    return () => window.clearInterval(timer)
  }, [upgrades?.organizerSeedBank?.level])
}

function useBulldozerRegression(bulldozer) {
  useEffect(() => {
    if (!database || !bulldozer?.active || bulldozer.truthExposes >= 5) return undefined
    const tick = () => {
      runTransaction(ref(database, 'gameState'), (current) => {
        if (!current?.phase1?.bulldozer?.active) return current
        const currentBulldozer = current.phase1.bulldozer
        const tickInterval = 2000
        if (currentBulldozer.truthExposes >= 5 || Date.now() - Number(currentBulldozer.lastTickAt || 0) < tickInterval) return current
        const pactLevel = Number(mergeUpgrades(current.upgrades).organizerPact.level || 0)
        const treeLoss = Math.max(1, 5 - pactLevel)
        return {
          ...current,
          trees: Math.max(0, Number(current.trees || 0) - treeLoss),
          phase1: {
            ...current.phase1,
            bulldozer: { ...currentBulldozer, lastTickAt: Date.now() },
          },
        }
      }).catch(() => {})
    }
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [bulldozer?.active, bulldozer?.truthExposes, bulldozer?.lastTickAt])
}

function FirebaseNotice({ connectionError }) {
  const { t } = useLanguage()
  if (isFirebaseConfigured && !connectionError) return null

  return (
    <div className="mx-auto mb-6 max-w-3xl rounded-2xl border border-clay/30 bg-orange-50 p-4 text-sm text-clay">
      <strong>{t('common.firebaseNotConnected')}</strong>
      <p className="mt-1">{connectionError || t('common.firebaseSetup')}</p>
    </div>
  )
}

function Header({ role }) {
  const { t } = useLanguage()
  const labels = { player: t('header.player'), screen: t('header.screen'), admin: t('header.admin') }
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-6">
      <div className="flex items-center gap-3">
        <div className="rounded-2xl bg-forest p-3 text-moss"><Leaf size={22} /></div>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-leaf">{t('header.classroomGame')}</p>
          <h1 className="text-xl font-black text-forest">Green Belt Movement</h1>
        </div>
      </div>
      <span className="rounded-full bg-moss px-4 py-2 text-sm font-bold text-forest">{labels[role]}</span>
    </header>
  )
}

function OppositionBanner({ event }) {
  const { t } = useLanguage()
  if (!event) return null
  const [titleKey, messageKey] = EVENT_TRANSLATIONS[event.title] || []
  const pointsLost = event.message?.match(/(\d+) points lost\.$/)?.[1]
  const message = titleKey
    ? `${t(messageKey)}${pointsLost ? ` ${t('admin.lostPoints', { points: pointsLost })}` : ''}`
    : event.message
  return (
    <div className="mx-auto mb-6 flex max-w-6xl items-start gap-3 rounded-2xl border border-clay/30 bg-orange-50 px-5 py-4 text-clay shadow-sm">
      <AlertTriangle className="mt-0.5 shrink-0" size={20} />
      <div><p className="font-black">{titleKey ? t(titleKey) : event.title}</p><p className="text-sm">{message}</p></div>
    </div>
  )
}

function LanguageToggle() {
  const { language, toggleLanguage } = useLanguage()
  return (
    <button
      aria-label="Toggle language"
      className="fixed bottom-5 right-5 z-20 rounded-full border border-forest/10 bg-white px-4 py-2 text-xs font-black text-forest shadow-lg transition hover:bg-moss"
      onClick={toggleLanguage}
      type="button"
    >
      {language === 'en' ? 'EN / 中' : '中 / EN'}
    </button>
  )
}

function ProgressBar({ label, value, target, color = 'bg-leaf' }) {
  const percentage = Math.min(100, (Number(value || 0) / target) * 100)
  return (
    <div>
      <div className="mb-2 flex justify-between text-sm font-bold">
        <span>{label}</span><span>{Number(value || 0).toLocaleString()} / {target.toLocaleString()}</span>
      </div>
      <div className="h-4 overflow-hidden rounded-full bg-forest/10">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  )
}

function getRoundNumber(phase) {
  const match = phase?.match(/^PHASE_2_ROUND_(\d)$/)
  return match ? Number(match[1]) : null
}

function getPhase2Event(eventId) {
  return PHASE_2_EVENTS.find((event) => event.id === eventId) || null
}

function getSituation(situationId) {
  return SURVIVAL_SITUATIONS.find((situation) => situation.id === situationId) || null
}

function getPhase1WaveRules(substage) {
  return PHASE1_WAVE_RULES[substage] || PHASE1_WAVE_RULES.WAVE_1
}

function countPlayerRoles(players) {
  return Object.values(players || {}).reduce((counts, player) => {
    if (player.role) counts[player.role] = (counts[player.role] || 0) + 1
    return counts
  }, { ...DEFAULT_PHASE1_STATE.roleCounts })
}

function addContribution(player, score, contributions = {}) {
  const updatedContributions = { ...(player.contributions || {}) }
  Object.entries(contributions).forEach(([key, amount]) => {
    updatedContributions[key] = Number(updatedContributions[key] || 0) + Number(amount || 0)
  })
  return {
    contributionPoints: Number(player.contributionPoints ?? player.actionCount ?? 0) + score,
    contributions: updatedContributions,
  }
}

function getContributionScore(player) {
  return Number(player?.contributionPoints ?? player?.actionCount ?? 0)
}

function getRankedPlayers(players) {
  return Object.entries(players || {})
    .map(([id, player]) => ({ id, ...player }))
    .sort((a, b) => getContributionScore(b) - getContributionScore(a)
      || Number(a.joinedAt || 0) - Number(b.joinedAt || 0)
      || String(a.id).localeCompare(String(b.id)))
}

function emptyAllocation() {
  return ALLOCATION_ITEMS.reduce((values, item) => ({ ...values, [item.id]: 0 }), {})
}

function FinalCountdownBanner({ endingAt, stage = false }) {
  const { t } = useLanguage()
  const seconds = useCountdownUntil(endingAt)
  if (!endingAt) return null
  return (
    <div className={`z-50 rounded-2xl bg-red-700 text-center font-black text-white shadow-2xl ${stage ? 'fixed inset-x-6 top-4 px-6 py-3 lg:py-5' : 'mb-5 px-4 py-4'}`}>
      <p className="text-sm uppercase tracking-widest">{t('results.countdownTitle')}</p>
      <p className={`${stage ? 'text-6xl lg:text-8xl' : 'text-6xl'}`}>{seconds}</p>
    </div>
  )
}

function PlayerResultsView({ gameState, playerId }) {
  const { t } = useLanguage()
  const rankedPlayers = getRankedPlayers(gameState.players)
  const rank = rankedPlayers.findIndex((player) => player.id === playerId) + 1
  const player = gameState.players?.[playerId] || {}
  const contributions = player.contributions || {}
  const contributionRows = [
    ['trees', 'treesContributed'],
    ['signatures', 'signaturesContributed'],
    ['seedlings', 'seedlingsNurtured'],
    ['rallies', 'ralliesLaunched'],
    ['persuasions', 'observersPersuaded'],
    ['communityActions', 'communityActions'],
    ['quizzes', 'quizzesCompleted'],
    ['massRallies', 'massRallies'],
  ].filter(([key]) => Number(contributions[key] || 0) > 0)

  return (
    <main className="min-h-[100dvh] w-full max-w-md mx-auto flex flex-col gap-5 px-4 pb-8">
      <section className="card bg-forest text-center text-white">
        <p className="text-sm font-bold uppercase tracking-widest text-moss">{t('phases.FINISHED')}</p>
        <h2 className="mt-2 text-3xl font-black">{t('results.movementSucceeded')}</h2>
        <p className="mt-4 text-2xl font-black">{t('results.playerRank', { rank: rank || '-', total: rankedPlayers.length })}</p>
        <p className="mt-2 text-moss">{player.role ? t(`roles.${player.role}.name`) : t('phase1.notSelected')}</p>
        <div className="mt-5 rounded-2xl bg-white/15 p-4">
          <p className="text-sm font-bold uppercase tracking-widest text-moss">{t('results.contributionScore')}</p>
          <p className="mt-1 text-5xl font-black">{getContributionScore(player).toLocaleString()}</p>
        </div>
      </section>
      <section className="card">
        <h3 className="text-xl font-black">{t('results.contributionSummary')}</h3>
        {contributionRows.length ? (
          <div className="mt-4 space-y-2">
            {contributionRows.map(([key, label]) => <div className="flex justify-between gap-3 rounded-xl bg-cream px-4 py-3" key={key}><span className="font-bold">{t(`results.${label}`)}</span><span className="shrink-0 font-black">{Number(contributions[key]).toLocaleString()}</span></div>)}
          </div>
        ) : <div className="mt-4 flex justify-between gap-3 rounded-xl bg-cream px-4 py-3"><span className="font-bold">{t('results.actionsCompleted')}</span><span className="shrink-0 font-black">{Number(player.actionCount || 0).toLocaleString()}</span></div>}
      </section>
    </main>
  )
}

function ScreenResultsView({ gameState, onReturnToLobby, isResetting, resetError }) {
  const { t } = useLanguage()
  const rankedPlayers = getRankedPlayers(gameState.players)
  const goals = mergeGoals(gameState.goals)
  const treeCount = Number(gameState.trees || 0)
  const petitionCount = Number(gameState.petitions || 0)
  const treesReached = treeCount >= goals.trees
  const petitionsReached = petitionCount >= goals.petitions
  const podiumPlaces = ['second', 'first', 'third']
  const podiumRank = { first: 0, second: 1, third: 2 }
  const podiumMedals = { first: '🥇', second: '🥈', third: '🥉' }
  const roleIcons = {
    Observer: '👀',
    'Tree Planter': '🌱',
    'Community Organizer': '🤝',
    'Publicity Campaigner': '📣',
  }
  return (
    <main className="flex min-h-[100dvh] w-screen flex-col items-center justify-center overflow-y-auto bg-[#e9efdf] p-4 text-center text-[#243d2f] lg:p-8">
      <p className="text-sm font-black uppercase tracking-[0.35em] text-[#557a52] lg:text-xl">{t('phases.FINISHED')}</p>
      <h1 className="mt-3 max-w-6xl text-3xl font-black sm:text-4xl lg:text-6xl">{t(treesReached && petitionsReached ? 'results.movementSucceeded' : 'results.movementEnded')}</h1>
      <div className="mt-5 grid w-full max-w-5xl grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-white/80 p-4 shadow-sm">
          <div className="flex items-center justify-center gap-2"><p className="text-sm font-bold text-[#557a52]">{t('results.finalTrees')}</p><span className={`rounded-full px-3 py-1 text-xs font-black ${treesReached ? 'bg-green-200 text-green-950' : 'bg-red-200 text-red-950'}`}>{t(treesReached ? 'results.goalMet' : 'results.goalNotMet')}</span></div>
          <p className="mt-1 text-3xl font-black lg:text-5xl">{treeCount.toLocaleString()} <span className="text-xl font-bold text-[#557a52]">/ {goals.trees.toLocaleString()}</span></p>
        </div>
        <div className="rounded-2xl bg-white/80 p-4 shadow-sm">
          <div className="flex items-center justify-center gap-2"><p className="text-sm font-bold text-[#557a52]">{t('results.finalSignatures')}</p><span className={`rounded-full px-3 py-1 text-xs font-black ${petitionsReached ? 'bg-green-200 text-green-950' : 'bg-red-200 text-red-950'}`}>{t(petitionsReached ? 'results.goalMet' : 'results.goalNotMet')}</span></div>
          <p className="mt-1 text-3xl font-black lg:text-5xl">{petitionCount.toLocaleString()} <span className="text-xl font-bold text-[#557a52]">/ {goals.petitions.toLocaleString()}</span></p>
        </div>
      </div>
      <section className="mt-5 w-full max-w-5xl pb-2">
        <h2 className="text-xl font-black uppercase tracking-widest text-[#557a52] lg:text-2xl">{t('results.podium')}</h2>
        <div className="mt-4 flex w-full items-end justify-center gap-2 sm:gap-4 lg:gap-6">
          {podiumPlaces.map((place) => {
            const player = rankedPlayers[podiumRank[place]]
            const isFirst = place === 'first'
            const podiumStyle = isFirst
              ? 'h-56 border-2 border-amber-400 bg-gradient-to-b from-amber-200/80 to-amber-100/70 shadow-lg shadow-amber-900/10'
              : place === 'second'
                ? 'h-44 border border-slate-400/70 bg-slate-200/70'
                : 'h-36 border border-orange-500/60 bg-orange-200/55'
            const placeTextStyle = isFirst ? 'text-amber-900' : 'text-[#43584a]'
            return (
              <div className={`flex min-w-0 flex-1 max-w-[16rem] flex-col items-center justify-center rounded-2xl p-2 sm:p-4 ${podiumStyle} ${player ? '' : 'border-dashed opacity-55'}`} key={place}>
                <p className={`font-black ${isFirst ? 'text-2xl sm:text-3xl' : 'text-lg sm:text-xl'} ${placeTextStyle}`}>{podiumMedals[place]} {t(`results.${place}`)}</p>
                {player ? (
                  <>
                    <p className={`mt-2 w-full truncate font-black ${isFirst ? 'text-xl text-amber-900 sm:text-3xl' : 'text-lg text-[#243d2f] sm:text-2xl'}`}>{player.nickname}</p>
                    <p className="mt-1 truncate text-sm font-bold text-[#49614d]" title={player.role ? t(`roles.${player.role}.name`) : undefined}>
                      <span className="mr-1" aria-hidden="true">{roleIcons[player.role] || '🌿'}</span>
                      {player.role ? t(`roles.${player.role}.name`) : t('phase1.notSelected')}
                    </p>
                    <p className="mt-1 text-sm font-bold text-[#243d2f]">{getContributionScore(player).toLocaleString()} {t(getContributionScore(player) === 1 ? 'results.pointSingular' : 'results.pointsAbbreviation')}</p>
                  </>
                ) : <p className="mt-3 text-sm font-bold">{t('results.waitingForHero')}</p>}
              </div>
            )
          })}
        </div>
      </section>
      <div className="mt-5 flex w-full max-w-5xl flex-col items-center gap-3">
        <button className="flex items-center gap-2 rounded-xl bg-[#315c3c] px-6 py-3 font-black text-white shadow-md transition hover:bg-[#24482e] disabled:cursor-wait disabled:opacity-60" disabled={isResetting} onClick={onReturnToLobby} type="button">
          <RotateCcw size={18} />
          {isResetting ? t('results.returningToLobby') : t('results.returnToLobby')}
        </button>
        {resetError && <p className="rounded-xl bg-red-100 px-4 py-3 text-sm font-bold text-red-800">{resetError}</p>}
      </div>
    </main>
  )
}

function Phase2PlayerView({ gameState, playerId }) {
  const { t } = useLanguage()
  const round = getRoundNumber(gameState.phase)
  const [allocation, setAllocation] = useState(emptyAllocation)
  const [error, setError] = useState('')
  const currentEvent = getPhase2Event(gameState.phase2Event?.id)
  const roundAllocation = gameState.roundAllocations?.[round]?.[playerId]
  const submitted = Boolean(roundAllocation?.submitted)
  const resourcePoints = currentEvent?.id === 'lack-of-funding' ? 7 : 10
  const totalSpent = Object.values(allocation).reduce((total, value) => total + value, 0)
  const remaining = resourcePoints - totalSpent

  useEffect(() => {
    setAllocation({ ...emptyAllocation(), ...(roundAllocation || {}) })
    setError('')
  }, [round, playerId, roundAllocation?.submittedAt])

  function adjustAllocation(itemId, amount) {
    setAllocation((current) => {
      const nextValue = Math.max(0, current[itemId] + amount)
      const otherTotal = Object.entries(current).reduce((total, [key, value]) => key === itemId ? total : total + value, 0)
      return { ...current, [itemId]: Math.min(nextValue, resourcePoints - otherTotal) }
    })
  }

  async function submitAllocation() {
    if (!database || remaining !== 0 || submitted) return
    try {
      await update(ref(database, `gameState/roundAllocations/${round}/${playerId}`), {
        ...allocation,
        totalSpent,
        submitted: true,
        submittedAt: serverTimestamp(),
      })
      setError('')
    } catch (submitError) {
      setError(`Unable to submit allocation: ${submitError.message}`)
    }
  }

  return (
    <main className="mx-auto max-w-lg space-y-5 px-5 pb-12">
      <section className="card">
        <p className="text-sm font-bold uppercase tracking-widest text-leaf">{t('phase2.currentRound')}</p>
        <h2 className="text-3xl font-black">{t(`phases.${gameState.phase}`)}</h2>
        <div className="mt-5 rounded-2xl bg-moss p-4">
          <p className="text-sm text-forest/60">{t('phase2.resources')}</p>
          <p className="mt-1 text-3xl font-black">{t('phase2.available', { points: resourcePoints })}</p>
          {currentEvent?.id === 'lack-of-funding' && <p className="mt-2 text-sm font-bold text-clay">{t('phase2.fundingPenalty')}</p>}
        </div>
      </section>

      <section className="card">
        <p className="text-sm font-bold uppercase tracking-widest text-clay">{t('phase2.currentCrisis')}</p>
        {currentEvent ? (
          <>
            <h3 className="mt-1 text-2xl font-black">{t(`phase2.${currentEvent.titleKey}`)}</h3>
            <p className="mt-2 text-sm text-forest/70">{t(`phase2.${currentEvent.descriptionKey}`)}</p>
          </>
        ) : <p className="mt-2 text-forest/60">{t('phase2.noEvent')}</p>}
      </section>

      <section className="card">
        <p className="mb-1 text-sm text-forest/70">{t('phase2.allocationInstructions')}</p>
        <p className={`mb-5 text-xl font-black ${remaining === 0 ? 'text-leaf' : 'text-clay'}`}>
          {remaining === 0 ? t('phase2.allAllocated') : t('phase2.remaining', { points: remaining })}
        </p>
        <div className="space-y-3">
          {ALLOCATION_ITEMS.map((item) => (
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-cream px-4 py-3" key={item.id}>
              <span className="font-bold">{t(`phase2.${item.labelKey}`)}</span>
              <div className="flex items-center gap-3">
                <button aria-label={`Decrease ${t(`phase2.${item.labelKey}`)}`} className="rounded-full border border-forest/15 p-2 disabled:opacity-30" disabled={submitted || allocation[item.id] === 0} onClick={() => adjustAllocation(item.id, -1)} type="button">−</button>
                <span className="w-5 text-center text-lg font-black">{allocation[item.id]}</span>
                <button aria-label={`Increase ${t(`phase2.${item.labelKey}`)}`} className="rounded-full border border-forest/15 p-2 disabled:opacity-30" disabled={submitted || remaining === 0} onClick={() => adjustAllocation(item.id, 1)} type="button">+</button>
              </div>
            </div>
          ))}
        </div>
        {submitted ? (
          <p className="mt-5 rounded-2xl bg-moss px-4 py-4 text-center font-black text-forest">{t('phase2.allocationLocked')}</p>
        ) : (
          <button className="mt-5 w-full rounded-2xl bg-forest px-4 py-4 font-black text-white hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-40" disabled={remaining !== 0} onClick={submitAllocation} type="button">{t('phase2.submitAllocation')}</button>
        )}
        {error && <p className="mt-3 text-sm font-bold text-clay">{error}</p>}
      </section>
    </main>
  )
}

function Phase2ScreenView({ gameState }) {
  const { t } = useLanguage()
  const round = getRoundNumber(gameState.phase)
  const currentEvent = getPhase2Event(gameState.phase2Event?.id)
  const players = Object.values(gameState.players || {})
  const allocations = round ? Object.values(gameState.roundAllocations?.[round] || {}) : []
  const submitted = allocations.filter((allocation) => allocation.submitted).length
  const indicators = gameState.indicators || DEFAULT_INDICATORS
  const isFinal = gameState.phase === 'FINAL_RESULTS'
  const ending = isFinal
    ? (indicators.forestHealth > 70 && indicators.environmentalAwareness > 70 && indicators.communityParticipation > 70 && indicators.publicSupport > 70
      ? { title: 'True Green Belt Legacy', description: 'A thriving forest and a united community built a legacy that will last.' }
      : indicators.forestHealth > 70 && indicators.publicSupport < 50
        ? { title: 'Fragile Victory: People Left Behind', description: 'The forest survived, but the community must heal the trust it lost.' }
        : indicators.environmentalAwareness > 70 && indicators.communityParticipation < 50
          ? { title: 'Eco-Aware, Community-Divided', description: 'The planet learned, yet the movement still needs stronger unity.' }
          : indicators.publicSupport > 70 && indicators.forestHealth < 50
            ? { title: 'A Movement Without Roots', description: 'Public support is strong, but urgent action is needed to restore the forest.' }
            : { title: 'The Green Belt Continues', description: 'The journey is unfinished, but every step has protected a hopeful future.' })
    : null

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-5 pb-12">
      <section className="rounded-[2rem] bg-forest p-8 text-white shadow-xl md:p-12">
        <p className="mb-2 text-sm font-bold uppercase tracking-[0.3em] text-moss">{isFinal ? t('phase2.finalResults') : t('phase2.saveTheForest')}</p>
        <h2 className="text-5xl font-black md:text-7xl">{t(`phases.${gameState.phase}`)}</h2>
        <p className="mt-4 text-moss">{isFinal ? t('phase2.resultsReady') : t('phase2.submitted', { submitted, total: players.length })}</p>
        {ending && <div className="mt-8 rounded-[2rem] border border-moss/40 bg-white/15 p-6 text-center shadow-[0_0_50px_rgba(74,222,128,0.35)]"><p className="text-sm font-bold uppercase tracking-[0.35em] text-moss">{t('phase2.endingTitle')}</p><h3 className="mt-3 text-4xl font-black">{ending.title}</h3><p className="mt-3 text-moss">{ending.description}</p></div>}
      </section>
      {!isFinal && (
        <section className="card">
          <p className="text-sm font-bold uppercase tracking-widest text-clay">{t('phase2.currentCrisis')}</p>
          {currentEvent ? <><h3 className="mt-1 text-3xl font-black">{t(`phase2.${currentEvent.titleKey}`)}</h3><p className="mt-2 text-forest/70">{t(`phase2.${currentEvent.descriptionKey}`)}</p></> : <p className="mt-2 text-forest/60">{t('phase2.noEvent')}</p>}
          <div className="mt-6 h-4 overflow-hidden rounded-full bg-forest/10"><div className="h-full rounded-full bg-leaf transition-all" style={{ width: `${players.length ? (submitted / players.length) * 100 : 0}%` }} /></div>
        </section>
      )}
      <section className="card space-y-6">
        <h3 className="text-2xl font-black">{t('phase2.communityIndicators')}</h3>
        {INDICATOR_KEYS.map((key) => <ProgressBar key={key} label={t(`phase2.${key}`)} value={indicators[key]} target={100} />)}
      </section>
    </main>
  )
}

function PlayerView({ gameState }) {
  const { t } = useLanguage()
  const playerTranslationRef = useRef(t)
  playerTranslationRef.current = t
  const [nickname, setNickname] = useState('')
  const [playerId, setPlayerId] = useState(() => window.sessionStorage.getItem('gbm-player-id') || '')
  const [error, setError] = useState('')
  const [selectedRole, setSelectedRole] = useState('')
  const [plantingStep, setPlantingStep] = useState(1)
  const [absorptionStartedAt, setAbsorptionStartedAt] = useState(0)
  const [absorptionDuration, setAbsorptionDuration] = useState(2000)
  const [plantingNow, setPlantingNow] = useState(Date.now())
  const [plantingNotice, setPlantingNotice] = useState('')
  const [floatingEffect, setFloatingEffect] = useState('')
  const [historyQuizOpen, setHistoryQuizOpen] = useState(false)
  const [usedQuestionIds, setUsedQuestionIds] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem('gbm-used-history-questions') || '[]')
    } catch {
      return []
    }
  })
  const [historyQuestionId, setHistoryQuestionId] = useState('')
  const [historyQuizCooldownUntil, setHistoryQuizCooldownUntil] = useState(() => Number(sessionStorage.getItem('gbm-history-cooldown') || 0))
  const [historyFeedback, setHistoryFeedback] = useState(null)
  const [selectedObserverId, setSelectedObserverId] = useState('')
  const [pitchFeedback, setPitchFeedback] = useState('')
  const [shieldLockedUntil, setShieldLockedUntil] = useState(0)
  const [shieldFeedback, setShieldFeedback] = useState(null)
  const [shieldSubmitting, setShieldSubmitting] = useState(false)
  const shieldLockSeconds = useCountdownUntil(shieldLockedUntil)
  function showFloatingEffect(text, vibrate = true) {
    if (vibrate) vibrateDevice()
    setFloatingEffect(text)
  }
  useEffect(() => {
    if (!floatingEffect) return undefined
    const timer = window.setTimeout(() => setFloatingEffect(''), 1500)
    return () => window.clearTimeout(timer)
  }, [floatingEffect])
  const confirmedPlayerRef = useRef(false)
  const rallySeconds = useRallyCountdown(gameState.rally)
  const momentumSeconds = useMomentumCountdown(gameState.phase1?.momentumBoost)
  const emergencySeconds = useCountdownUntil(gameState.emergency?.endsAt)
  const player = playerId ? gameState.players?.[playerId] : null
  const currentRole = player?.role || null
  const phase1State = gameState.phase1 || DEFAULT_PHASE1_STATE
  const roleLevels = mergeRoleLevels(gameState.roleLevels)
  const upgradeFlow = ROLE_UPGRADE_FLOWS[currentRole]
  const organizationAP = mergeOrganizationAP(gameState.organizationAP)
  const upgrades = mergeUpgrades(gameState.upgrades)
  const currentGroupAP = Number(organizationAP[ROLE_AP_KEYS[currentRole]] || 0)
  const dualBranches = currentRole === 'Community Organizer'
    ? [
        { key: 'planterTools', titleKey: 'planterTools', descriptionKey: 'planterToolsEffect' },
        { key: 'planterIrrigation', titleKey: 'planterIrrigation', descriptionKey: 'planterIrrigationEffect' },
        { key: 'planterFertilization', titleKey: 'planterFertilization', descriptionKey: 'planterFertilizationEffect' },
      ]
    : currentRole === 'Tree Planter'
      ? [
          { key: 'campaignerMegaphone', titleKey: 'campaignerMegaphone', descriptionKey: 'campaignerMegaphoneEffect' },
          { key: 'campaignerNetwork', titleKey: 'campaignerNetwork', descriptionKey: 'campaignerNetworkEffect' },
          { key: 'campaignerMedia', titleKey: 'campaignerMedia', descriptionKey: 'campaignerMediaEffect' },
        ]
      : currentRole === 'Publicity Campaigner'
        ? [
            { key: 'organizerGreenhouse', titleKey: 'organizerGreenhouse', descriptionKey: 'organizerGreenhouseEffect' },
            { key: 'organizerPact', titleKey: 'organizerPact', descriptionKey: 'organizerPactEffect' },
            { key: 'organizerSeedBank', titleKey: 'organizerSeedBank', descriptionKey: 'organizerSeedBankEffect' },
          ]
        : []
  const targetLevel = upgradeFlow ? Number(roleLevels[upgradeFlow.levelKey] || 1) : 1
  const targetProgress = upgradeFlow ? Number(roleLevels[upgradeFlow.progressKey] || 0) : 0
  const waveRules = getPhase1WaveRules(phase1State.substage)
  const boostSeconds = useCountdownUntil(phase1State.boostExpiresAt)
  const boostActive = boostSeconds > 0 && playerId !== gameState.rally?.startedBy
  const campaignCooldownMs = getActionCooldownMs(waveRules.campaignCooldownMs, boostActive)
  const campaignCooldownUntil = Number(player?.lastSolutionSentAt || 0) + campaignCooldownMs
  const campaignCooldownSeconds = useCountdownUntil(campaignCooldownUntil)
  const pitchCooldownSeconds = useCountdownUntil(Number(player?.lastPitchAt || 0) + MIN_ACTION_COOLDOWN_MS)
  const nurtureCooldownMs = getActionCooldownMs(waveRules.actionCooldownMs, boostActive)
  const nurtureCooldownSeconds = useCountdownUntil(Number(player?.lastNurtureAt || 0) + nurtureCooldownMs)
  const organizerPactLevel = Number(upgrades.organizerPact.level || 0)
  const rallyCooldownMs = Math.max(MIN_ACTION_COOLDOWN_MS, 15000 - organizerPactLevel * 1500)
  const rallyCooldownSeconds = useCountdownUntil(Number(player?.lastRallyAt || 0) + rallyCooldownMs)
  const historyQuizCooldownSeconds = useCountdownUntil(historyQuizCooldownUntil)
  const observerActionCooldownMs = getActionCooldownMs(8000, boostActive)
  const demandCooldownSeconds = useCountdownUntil(Number(player?.lastDemandAt || 0) + observerActionCooldownMs)
  const concernCooldownSeconds = useCountdownUntil(Number(player?.lastConcernAt || 0) + observerActionCooldownMs)
  const absorptionProgress = plantingStep === 3 && absorptionStartedAt
    ? Math.min(100, ((plantingNow - absorptionStartedAt) / absorptionDuration) * 100)
    : 0
  const absorptionComplete = absorptionProgress >= 100
  const situation = getSituation(player?.situation)
  const solutionAvailable = Boolean(situation && player?.solutionReceived)
  const roleCounts = Object.values(gameState.players || {}).reduce((counts, entry) => ({
    ...counts,
    [entry.role]: (counts[entry.role] || 0) + 1,
  }), {})
  const actionRoleIds = ['Tree Planter', 'Community Organizer', 'Publicity Campaigner']
  const actionRoleCapacity = actionRoleIds.reduce((total, role) => total + Number(phase1State.roleLimits?.[role] ?? 0), 0)
  const actionRoleCount = actionRoleIds.reduce((total, role) => total + Number(roleCounts[role] || 0), 0)
  const eligibleObservers = Object.entries(gameState.players || {}).filter(([, entry]) => entry.role === 'Observer' && !entry.convinced)
  const remainingObservers = Object.entries(gameState.players || {}).filter(([, entry]) => entry.role === 'Observer')
  const observerCounts = SURVIVAL_SITUATIONS.reduce((counts, item) => ({
    ...counts,
    [item.id]: Object.values(gameState.players || {}).filter((entry) => entry.role === 'Observer' && entry.situation === item.id && !entry.convinced).length,
  }), {})
  const readyObserverCounts = SURVIVAL_SITUATIONS.reduce((counts, item) => ({
    ...counts,
    [item.id]: Object.values(gameState.players || {}).filter((entry) => entry.role === 'Observer' && entry.situation === item.id && Number(entry.awakeningProgress || 0) >= 70 && !entry.convinced).length,
  }), {})

  useEffect(() => {
    if (!database || !playerId) return undefined
    confirmedPlayerRef.current = false
    let initialSnapshotReceived = false
    const unsubscribe = onValue(ref(database, `gameState/players/${playerId}`), (snapshot) => {
      if (snapshot.exists()) {
        initialSnapshotReceived = true
        confirmedPlayerRef.current = true
        return
      }
      if (!initialSnapshotReceived || !confirmedPlayerRef.current) return
      window.sessionStorage.removeItem('gbm-player-id')
      setPlayerId('')
      setError(playerTranslationRef.current('player.removedMessage'))
    })
    return unsubscribe
  }, [playerId])

  useEffect(() => {
    if (!playerId || gameState.phase !== 'PHASE_1' || currentRole || actionRoleCount < actionRoleCapacity) return
    chooseRole('Observer')
  }, [playerId, gameState.phase, currentRole, actionRoleCount, actionRoleCapacity])

  useEffect(() => {
    if (currentRole !== 'Tree Planter' || gameState.phase !== 'PHASE_1') {
      setPlantingStep(1)
      setAbsorptionStartedAt(0)
    }
  }, [currentRole, gameState.phase, phase1State.substage])

  useEffect(() => {
    if (plantingStep !== 3) return undefined
    const timer = window.setInterval(() => setPlantingNow(Date.now()), 50)
    return () => window.clearInterval(timer)
  }, [plantingStep])

  useEffect(() => {
    if (!plantingNotice) return undefined
    const timer = window.setTimeout(() => setPlantingNotice(''), 2200)
    return () => window.clearTimeout(timer)
  }, [plantingNotice])

  useEffect(() => {
    if (!gameState.resetAt) return
    const resetHandled = Number(sessionStorage.getItem('gbm-reset-at') || 0)
    if (resetHandled >= Number(gameState.resetAt)) return
    sessionStorage.setItem('gbm-reset-at', String(gameState.resetAt))
    sessionStorage.removeItem('gbm-history-cooldown')
    sessionStorage.removeItem('gbm-used-history-questions')
    sessionStorage.removeItem('gbm-last-history-question')
    setUsedQuestionIds([])
    setHistoryQuestionId('')
    setHistoryQuizCooldownUntil(0)
    setHistoryQuizOpen(false)
    setHistoryFeedback(null)
  }, [gameState.resetAt])

  async function joinLobby(event) {
    event.preventDefault()
    const cleanName = nickname.trim()
    if (!cleanName) return setError(t('player.enterNickname'))
    if (!database) return setError(t('common.firebaseNotConnected'))

    try {
      const deviceTokenHash = await getOrCreateDeviceTokenHash()
      const previousPlayerId = window.sessionStorage.getItem('gbm-player-id')
      const playerRef = push(ref(database, 'gameState/players'))
      const newPlayerId = playerRef.key
      if (!newPlayerId) throw new Error(t('player.unableToJoin'))

      let duplicateNickname = false
      let lobbyUnavailable = false
      let restoredPlayerId = ''
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        duplicateNickname = false
        lobbyUnavailable = false
        restoredPlayerId = ''
        if (!current) return undefined
        const normalizedName = normalizeNickname(cleanName)
        const existingEntry = Object.entries(current.players || {}).find(
          ([, existingPlayer]) => normalizeNickname(existingPlayer?.nickname) === normalizedName,
        )
        if (existingEntry) {
          const [existingId, existingPlayer] = existingEntry
          if (existingPlayer.deviceTokenHash === deviceTokenHash || existingId === previousPlayerId) {
            restoredPlayerId = existingId
            return existingPlayer.deviceTokenHash === deviceTokenHash
              ? current
              : {
                  ...current,
                  players: {
                    ...current.players,
                    [existingId]: { ...existingPlayer, deviceTokenHash },
                  },
                }
          }
          duplicateNickname = true
          return undefined
        }
        if (current.phase !== 'LOBBY') {
          lobbyUnavailable = true
          return undefined
        }
        return {
          ...current,
          players: {
            ...(current.players || {}),
            [newPlayerId]: {
              nickname: cleanName,
              deviceTokenHash,
              role: null,
              actionCount: 0,
              contributionPoints: 0,
              contributions: {},
              joinedAt: Date.now(),
            },
          },
        }
      })

      if (!result.committed) {
        if (duplicateNickname) return setError(t('player.nicknameTaken'))
        if (lobbyUnavailable) return setError(t('player.lobbyUnavailable'))
        return setError(t('player.unableToJoin'))
      }

      const joinedPlayerId = restoredPlayerId || newPlayerId
      window.sessionStorage.setItem('gbm-player-id', joinedPlayerId)
      setPlayerId(joinedPlayerId)
      setError('')
    } catch (joinError) {
      setError(`${t('player.unableToJoin')}: ${joinError.message}`)
    }
  }

  async function chooseRole(role) {
    if (!playerId || !database) return
    vibrateDevice()
    if (currentRole === 'Observer' && phase1State.allowRoleSwitch === false && !player?.convinced) {
      setError(t('phase1.observerPersuasionRequired'))
      return
    }
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        if (current?.phase !== 'PHASE_1' || !current?.players?.[playerId]) return undefined
        const limits = {
          ...DEFAULT_PHASE1_STATE.roleLimits,
          ...(current.phase1?.roleLimits || {}),
        }
        const playerEntries = Object.entries(current.players)
        const currentRoleCount = playerEntries.filter(([id, entry]) => id !== playerId && entry.role === role).length
        if (role !== 'Observer' && currentRoleCount >= Number(limits[role] || 0)) return undefined
        const nextPlayer = {
          ...current.players[playerId],
          role,
          situation: role === 'Observer'
            ? (current.players[playerId].situation || SURVIVAL_SITUATIONS[Math.floor(Math.random() * SURVIVAL_SITUATIONS.length)].id)
            : null,
          needType: role === 'Observer'
            ? (current.players[playerId].needType || OBSERVER_NEEDS[Math.floor(Math.random() * OBSERVER_NEEDS.length)].id)
            : null,
          convinced: role === 'Observer' ? Boolean(current.players[playerId].convinced) : false,
          solutionReceived: false,
          awakeningProgress: role === 'Observer' ? Number(current.players[playerId].awakeningProgress || 0) : 0,
          communityPoints: role === 'Observer' ? Number(current.players[playerId].communityPoints || 0) : 0,
        }
        const nextPlayers = { ...current.players, [playerId]: nextPlayer }
        const previousRole = current.players[playerId]?.role
        const persuadedConversion = previousRole === 'Observer' && Boolean(current.players[playerId].convinced)
        const updatedPhase1 = {
          ...current.phase1,
          roleCounts: countPlayerRoles(nextPlayers),
          roleLimits: persuadedConversion && role !== 'Observer'
            ? {
                ...DEFAULT_PHASE1_STATE.roleLimits,
                ...(current.phase1?.roleLimits || {}),
                [role]: Number((current.phase1?.roleLimits || {})[role] ?? DEFAULT_PHASE1_STATE.roleLimits[role] ?? 2) + 1,
              }
            : {
                ...DEFAULT_PHASE1_STATE.roleLimits,
                ...(current.phase1?.roleLimits || {}),
              },
        }
        return {
          ...current,
          players: nextPlayers,
          phase1: updatedPhase1,
        }
      })
      if (!result.committed) {
        setError(t('phase1.roleFull'))
        return
      }
      setSelectedRole('')
      setError('')
    } catch (roleError) {
      setError(`${t('player.unableToChooseRole')}: ${roleError.message}`)
    }
  }

  function digSoil() {
    if (currentRole !== 'Tree Planter' || plantingStep !== 1) return
    vibrateDevice()
    setPlantingStep(2)
    setError('')
  }

  async function plantSeedling() {
    if (!database || currentRole !== 'Tree Planter' || plantingStep !== 2) return
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        const seeds = Number(current?.sharedSeeds ?? current?.seeds ?? 0)
        const upgrades = mergeUpgrades(current.upgrades)
        const irrigationLevel = Number(upgrades.planterIrrigation.level || 0)
        const bypassSeed = irrigationLevel > 0 && Math.random() < irrigationLevel * 0.15
        if (seeds <= 0 && !bypassSeed) return undefined
        if (bypassSeed) return current
        if (seeds <= 0) return undefined
        return { ...current, seeds: seeds - 1, sharedSeeds: seeds - 1 }
      })
      if (!result.committed) {
        setError(t('phase1.noSeeds'))
        return
      }
      const currentState = result.snapshot.val()
      const currentWaveRules = getPhase1WaveRules(currentState.phase1?.substage)
      const irrigationLevel = Number(mergeUpgrades(currentState.upgrades).planterIrrigation.level || 0)
      const baseCooldown = Math.max(MIN_ACTION_COOLDOWN_MS, currentWaveRules.actionCooldownMs - irrigationLevel * 400)
      const duration = getActionCooldownMs(
        baseCooldown,
        Number(currentState.phase1?.boostExpiresAt || 0) > Date.now()
          && currentState.rally?.startedBy !== playerId,
      )
      setAbsorptionDuration(duration)
      setAbsorptionStartedAt(Date.now())
      setPlantingNow(Date.now())
      setPlantingStep(3)
      setError('')
    } catch (plantError) {
      setError(`${t('player.unableToPlant')}: ${plantError.message}`)
    }
  }

  async function harvestGrove() {
    if (!database || currentRole !== 'Tree Planter' || plantingStep !== 3 || !absorptionComplete) return
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        const currentPlayer = current?.players?.[playerId]
        if (current?.phase !== 'PHASE_1' || !currentPlayer || currentPlayer.role !== 'Tree Planter') return undefined
        const upgrades = mergeUpgrades(current.upgrades)
        const baseYield = current.phase1?.substage === 'WAVE_2' ? 16 : current.phase1?.substage === 'WAVE_3' ? 24 : 8
        let upgradedYield = baseYield + Number(upgrades.planterTools.level || 0) * 6
        if (Math.random() < Number(upgrades.planterFertilization.level || 0) * 0.2) upgradedYield *= 2
        return {
          ...current,
          trees: Number(current.trees || 0) + upgradedYield,
          organizationAP: adjustRoleAP(current.organizationAP, 'Tree Planter', 1),
          players: {
            ...current.players,
            [playerId]: {
              ...currentPlayer,
              ...addContribution(currentPlayer, 1, { trees: upgradedYield }),
              actionCount: Number(currentPlayer.actionCount || 0) + 1,
            },
          },
        }
      })
      if (!result.committed) return
      const baseYield = phase1State.substage === 'WAVE_2' ? 16 : phase1State.substage === 'WAVE_3' ? 24 : 8
      const upgradedYield = baseYield + Number(upgrades.planterTools.level || 0) * 6
      setPlantingNotice(t('phase1.treesPlantedFlash', { trees: upgradedYield }))
      showFloatingEffect(`+${upgradedYield} 🌲`)
      setPlantingStep(1)
      setAbsorptionStartedAt(0)
      setError('')
    } catch (harvestError) {
      setError(`${t('player.unableToPlant')}: ${harvestError.message}`)
    }
  }

  async function convinceObserver() {
    if (!database || !playerId || !solutionAvailable) return
    try {
      await runTransaction(ref(database, `gameState/players/${playerId}`), (current) => {
        if (!current || current.role !== 'Observer' || !current.solutionReceived) return undefined
        if (Number(current.awakeningProgress || 0) < 70) return undefined
        return { ...current, awakeningProgress: 100, convinced: true, solutionReceived: false }
      })
      setError('')
    } catch (convinceError) {
      setError(`Unable to join the movement: ${convinceError.message}`)
    }
  }

  async function performObserverAction(actionType) {
    if (!database || !playerId || currentRole !== 'Observer') return
    const cooldownField = actionType === 'demand' ? 'lastDemandAt' : 'lastConcernAt'
    const cooldownSeconds = actionType === 'demand' ? demandCooldownSeconds : concernCooldownSeconds
    if (cooldownSeconds > 0) return
    vibrateDevice()
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        const currentPlayer = current?.players?.[playerId]
        if (current?.phase !== 'PHASE_1' || !currentPlayer || currentPlayer.role !== 'Observer') return undefined
        const cooldownMs = getActionCooldownMs(
          8000,
          Number(current?.phase1?.boostExpiresAt || 0) > Date.now()
            && current?.rally?.startedBy !== playerId,
        )
        if (Date.now() - Number(currentPlayer[cooldownField] || 0) < cooldownMs) return undefined
        const gain = actionType === 'demand' ? 5 : 3
        const points = actionType === 'demand' ? 2 : 1
        const progress = Math.min(70, Number(currentPlayer.awakeningProgress || 0) + gain)
        return {
          ...current,
          organizationAP: adjustRoleAP(current.organizationAP, 'Observer', points),
          players: {
            ...current.players,
            [playerId]: {
              ...currentPlayer,
              ...addContribution(currentPlayer, 1, { communityActions: 1 }),
              awakeningProgress: progress,
              communityPoints: Number(currentPlayer.communityPoints || 0) + points,
              actionCount: Number(currentPlayer.actionCount || 0) + 1,
              [cooldownField]: Date.now(),
            },
          },
          activityFeed: {
            ...(current.activityFeed || {}),
            [push(ref(database, 'gameState/activityFeed')).key]: {
              type: actionType,
              playerName: currentPlayer.nickname,
              situation: currentPlayer.situation,
              highlightedUntil: actionType === 'demand' ? Date.now() + 10000 : 0,
              createdAt: Date.now(),
            },
          },
        }
      })
      if (!result.committed) return
      showFloatingEffect(actionType === 'demand' ? '+5% · +2 Group AP' : '+3% · +1 Group AP')
    } catch (actionError) {
      setError(`${t('phase1.observerActionFailed')}: ${actionError.message}`)
    }
  }

  async function pitchObserver(needType) {
    if (!database || currentRole !== 'Publicity Campaigner') return
    if (!selectedObserverId) {
      setPitchFeedback(t('phase1.selectObserverFirst'))
      return
    }
    vibrateDevice()
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        const campaigner = current?.players?.[playerId]
        const observer = current?.players?.[selectedObserverId]
        if (current?.phase !== 'PHASE_1' || !campaigner || campaigner.role !== 'Publicity Campaigner' || !observer || observer.role !== 'Observer') return undefined
        const currentWaveRules = getPhase1WaveRules(current.phase1?.substage)
        const boostActive = Number(current.phase1?.boostExpiresAt || 0) > Date.now()
          && current.rally?.startedBy !== playerId
        const campaignCooldownMs = getActionCooldownMs(currentWaveRules.campaignCooldownMs, boostActive)
        if (Date.now() - Number(campaigner.lastSolutionSentAt || 0) < campaignCooldownMs) return undefined
        const lastSentAt = Number(campaigner.lastPitchAt || 0)
        if (Date.now() - lastSentAt < MIN_ACTION_COOLDOWN_MS) return undefined
        if (observer.needType !== needType) {
          return {
            ...current,
            players: {
              ...current.players,
              [playerId]: { ...campaigner, lastPitchAt: Date.now(), lastPitchMatched: false },
            },
          }
        }
        const substage = current?.phase1?.substage || 'WAVE_1'
        const gain = substage === 'WAVE_3' ? 45 : substage === 'WAVE_2' ? 30 : 15
        const progress = Math.min(100, Number(observer.awakeningProgress || 0) + gain)
        const alternativeNeeds = OBSERVER_NEEDS.filter((need) => need.id !== observer.needType)
        const nextNeed = progress < 100 && !observer.convinced
          ? alternativeNeeds[Math.floor(Math.random() * alternativeNeeds.length)].id
          : observer.needType
        const needChangedAt = progress < 100 && !observer.convinced ? Date.now() : observer.needChangedAt || null
        return {
          ...current,
          petitions: Number(current.petitions || 0) + 5,
          trees: Number(current.trees || 0) + (Number(mergeUpgrades(current.upgrades).campaignerNetwork.level || 0) * 5),
          players: {
            ...current.players,
            [selectedObserverId]: {
              ...observer,
              needType: nextNeed,
              needChangedAt,
              awakeningProgress: progress,
              solutionReceived: progress >= 70,
            },
            [playerId]: {
              ...campaigner,
              ...addContribution(campaigner, 1, {
                persuasions: 1,
                signatures: 5,
                trees: Number(mergeUpgrades(current.upgrades).campaignerNetwork.level || 0) * 5,
              }),
              lastPitchAt: Date.now(),
              lastPitchMatched: true,
              lastSolutionSentAt: Date.now(),
              actionCount: Number(campaigner.actionCount || 0) + 1,
            },
          },
          organizationAP: adjustRoleAP(current.organizationAP, 'Publicity Campaigner', 1),
          activityFeed: {
            ...(current.activityFeed || {}),
            [push(ref(database, 'gameState/activityFeed')).key]: {
              type: 'solution',
              playerName: campaigner.nickname,
              targetName: observer.nickname,
              createdAt: Date.now(),
            },
          },
        }
      })
      if (!result.committed) return
      const pitchMatched = result.snapshot.val()?.players?.[playerId]?.lastPitchMatched
      if (pitchMatched) {
        setPitchFeedback(t('phase1.matchedNeed'))
        showFloatingEffect('✅ + persuasion')
      } else {
        setPitchFeedback(t('phase1.wrongPitch'))
      }
    } catch (pitchError) {
      setPitchFeedback(`${t('phase1.pitchFailed')}: ${pitchError.message}`)
    }
  }

  async function launchMassPetitionRally() {
    if (!database || currentRole !== 'Publicity Campaigner') return
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        const campaigner = current?.players?.[playerId]
        if (current?.phase !== 'PHASE_1' || !campaigner || campaigner.role !== 'Publicity Campaigner') return undefined
        const eligibleObservers = Object.values(current.players || {}).filter((entry) => entry.role === 'Observer' && !entry.convinced)
        const waveRules = getPhase1WaveRules(current.phase1?.substage)
        const cooldownMs = getActionCooldownMs(
          waveRules.campaignCooldownMs,
          Number(current.phase1?.boostExpiresAt || 0) > Date.now() && current.rally?.startedBy !== playerId,
        )
        const now = Date.now()
        if (eligibleObservers.length || now - Number(campaigner.lastSolutionSentAt || 0) < cooldownMs
          || now - Number(campaigner.lastPitchAt || 0) < MIN_ACTION_COOLDOWN_MS) return undefined
        return {
          ...current,
          petitions: Number(current.petitions || 0) + 150,
          players: {
            ...current.players,
            [playerId]: {
              ...campaigner,
              ...addContribution(campaigner, 150, { signatures: 150, massRallies: 1 }),
              actionCount: Number(campaigner.actionCount || 0) + 1,
              lastPitchAt: now,
              lastSolutionSentAt: now,
            },
          },
          activityFeed: {
            ...(current.activityFeed || {}),
            [push(ref(database, 'gameState/activityFeed')).key]: {
              type: 'massPetition',
              playerName: campaigner.nickname,
              createdAt: now,
            },
          },
        }
      })
      if (!result.committed) {
        setPitchFeedback(t('phase1.massRallyUnavailable'))
        return
      }
      setPitchFeedback(t('phase1.massRallySuccess'))
      showFloatingEffect('+150 signatures · +150 points')
    } catch (rallyError) {
      setPitchFeedback(`${t('phase1.pitchFailed')}: ${rallyError.message}`)
    }
  }

  async function exposeTruth() {
    if (!database || currentRole !== 'Publicity Campaigner') return
    try {
      await runTransaction(ref(database, 'gameState/phase1/bulldozer'), (current) => {
        if (!current?.active || current.truthExposes >= 5) return current
        const truthExposes = Number(current.truthExposes || 0) + 1
        return { ...current, truthExposes, active: truthExposes < 5 }
      })
      setError('')
    } catch (truthError) {
      setError(`Unable to expose the truth: ${truthError.message}`)
    }
  }

  async function nurtureSeedlings() {
    if (!database || currentRole !== 'Community Organizer' || nurtureCooldownSeconds > 0) return
    vibrateDevice()
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        const currentPlayer = current?.players?.[playerId]
        const currentWaveRules = getPhase1WaveRules(current?.phase1?.substage)
        const nurtureCooldownMs = getActionCooldownMs(
          currentWaveRules.actionCooldownMs,
          Number(current?.phase1?.boostExpiresAt || 0) > Date.now()
            && current?.rally?.startedBy !== playerId,
        )
        if (current?.phase !== 'PHASE_1' || !currentPlayer || currentPlayer.role !== 'Community Organizer' || Date.now() - Number(currentPlayer.lastNurtureAt || 0) < nurtureCooldownMs) return undefined
        const levels = mergeRoleLevels(current.roleLevels)
        const upgrades = mergeUpgrades(current.upgrades)
        const sharedSeeds = Number(current.sharedSeeds ?? current.seeds ?? 0) + 8 + Number(upgrades.organizerGreenhouse.level || 0) * 4
        return {
          ...current,
          seeds: sharedSeeds,
          sharedSeeds,
          organizationAP: adjustRoleAP(current.organizationAP, 'Community Organizer', 1),
          players: {
            ...current.players,
            [playerId]: {
              ...currentPlayer,
              ...addContribution(currentPlayer, 1, { seedlings: 8 + Number(upgrades.organizerGreenhouse.level || 0) * 4 }),
              lastNurtureAt: Date.now(),
              actionCount: Number(currentPlayer.actionCount || 0) + 1,
            },
          },
          activityFeed: {
            ...(current.activityFeed || {}),
            [push(ref(database, 'gameState/activityFeed')).key]: {
              type: 'nurture',
              playerName: currentPlayer.nickname,
              createdAt: Date.now(),
            },
          },
        }
      })
      if (!result.committed) return
      showFloatingEffect('+8 🌱 · +1 Group AP')
      setError('')
    } catch (nurtureError) {
      setError(`${t('player.unableToNurture')}: ${nurtureError.message}`)
    }
  }

  async function launchRally() {
    if (!database || currentRole !== 'Community Organizer' || rallyCooldownSeconds > 0) return
    vibrateDevice()
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        const currentPlayer = current?.players?.[playerId]
        const currentWaveRules = getPhase1WaveRules(current?.phase1?.substage)
        const pactLevel = Number(mergeUpgrades(current?.upgrades).organizerPact.level || 0)
        const cooldown = Math.max(MIN_ACTION_COOLDOWN_MS, 15000 - pactLevel * 1500)
        if (current?.phase !== 'PHASE_1' || !currentPlayer || currentPlayer.role !== 'Community Organizer' || Date.now() - Number(currentPlayer.lastRallyAt || 0) < cooldown) return undefined
        const boostExpiresAt = Date.now() + 5000
        return {
          ...current,
          rally: {
            active: true,
            type: currentWaveRules.megaRallyUnlocked ? 'mega' : 'workday',
            endsAt: boostExpiresAt,
            startedBy: playerId,
            startedAt: serverTimestamp(),
          },
          phase1: { ...current.phase1, boostExpiresAt },
          players: {
            ...current.players,
            [playerId]: {
              ...currentPlayer,
              ...addContribution(currentPlayer, 1, { rallies: 1 }),
              actionCount: Number(currentPlayer.actionCount || 0) + 1,
              lastRallyAt: Date.now(),
            },
          },
        }
      })
      if (!result.committed) return
      setError('')
    } catch (rallyError) {
      setError(`${t('player.unableToLaunchRally')}: ${rallyError.message}`)
    }
  }

  async function supportUpgrade() {
    if (!database || !playerId || !currentRole) return
    vibrateDevice()
  }

  async function supportUpgradeBranch(branchKey) {
    if (!database || !playerId || !currentRole) return
    vibrateDevice()
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        const currentPlayer = current?.players?.[playerId]
        const apKey = ROLE_AP_KEYS[currentRole]
        const groupAP = mergeOrganizationAP(current?.organizationAP)
        const availableAP = Number(groupAP[apKey] || 0)
        const allowedBranches = {
          'Community Organizer': ['planterTools', 'planterIrrigation', 'planterFertilization'],
          'Tree Planter': ['campaignerMegaphone', 'campaignerNetwork', 'campaignerMedia'],
          'Publicity Campaigner': ['organizerGreenhouse', 'organizerPact', 'organizerSeedBank'],
        }[currentRole] || []
        if (current?.phase !== 'PHASE_1' || !currentPlayer || currentPlayer.role !== currentRole || availableAP < 3 || !allowedBranches.includes(branchKey)) return undefined
        const upgrades = mergeUpgrades(current.upgrades)
        const branch = upgrades[branchKey]
        if (Number(branch.level || 0) >= 4) return undefined
        const progress = Number(branch.progress || 0) + 1
        const totalPlayers = Object.keys(current.players || {}).length
        const requiredProgress = Math.max(4, Math.ceil(totalPlayers * 1.2)) * (Number(branch.level || 0) + 1)
        const reachedLevel = progress >= requiredProgress
        return {
          ...current,
          organizationAP: adjustRoleAP(current.organizationAP, currentRole, -3),
          upgrades: {
            ...upgrades,
            [branchKey]: {
              level: reachedLevel ? Number(branch.level || 0) + 1 : Number(branch.level || 0),
              progress: reachedLevel ? 0 : progress,
            },
          },
        }
      })
      if (!result.committed) {
        setError(t('phase1.upgradeUnavailable'))
        return
      }
      setError('')
    } catch (upgradeError) {
      setError(`${t('phase1.upgradeUnavailable')}: ${upgradeError.message}`)
    }
  }

  async function clickEmergencyShield(color) {
    if (!database || !gameState.emergency?.active || shieldLockSeconds > 0 || shieldSubmitting) return
    vibrateDevice()
    setShieldFeedback(null)
    setShieldSubmitting(true)
    try {
      let outcome = ''
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        outcome = ''
        const event = mergeEmergencyEvent(current?.emergency)
        const currentPlayer = current?.players?.[playerId]
        if (current?.phase !== 'PHASE_1' || !event.active || Date.now() >= Number(event.endsAt) || !currentPlayer) return undefined

        if (color !== event.targetColor) {
          outcome = 'wrong'
          return {
            ...current,
            players: {
              ...current.players,
              [playerId]: {
                ...currentPlayer,
                contributionPoints: Math.max(0, getContributionScore(currentPlayer) - 10),
              },
            },
          }
        }

        outcome = 'correct'
        const clicks = Number(event.shieldClicks || 0) + 1
        return {
          ...current,
          emergency: {
            ...event,
            shieldClicks: clicks,
            active: clicks < 80,
            resolved: clicks >= 80 ? 'success' : null,
          },
          players: {
            ...current.players,
            [playerId]: {
              ...currentPlayer,
              ...addContribution(currentPlayer, 15, { emergencyShields: 1 }),
              actionCount: Number(currentPlayer.actionCount || 0) + 1,
            },
          },
        }
      })

      if (!result.committed) return
      if (outcome === 'wrong') {
        setShieldLockedUntil(Date.now() + 2000)
        setShieldFeedback({ type: 'wrong', text: t('phase1.wrongSignal') })
      } else if (outcome === 'correct') {
        setShieldFeedback({ type: 'correct', text: t('phase1.shieldCorrectFeedback') })
      }
    } catch (shieldError) {
      setShieldFeedback({ type: 'wrong', text: `${t('phase1.emergencyFailed')}: ${shieldError.message}` })
    } finally {
      setShieldSubmitting(false)
    }
  }

  function openHistoryQuiz() {
    if (historyQuizCooldownSeconds > 0 || historyQuizOpen) return
    vibrateDevice()
    const lastId = sessionStorage.getItem('gbm-last-history-question') || ''
    const question = drawHistoryQuestion(usedQuestionIds, lastId)
    const nextUsed = usedQuestionIds.includes(question.id)
      ? usedQuestionIds
      : [...usedQuestionIds, question.id]
    const resetUsed = nextUsed.length >= HISTORY_TRIVIA.length ? [question.id] : nextUsed
    setUsedQuestionIds(resetUsed)
    setHistoryQuestionId(question.id)
    sessionStorage.setItem('gbm-used-history-questions', JSON.stringify(resetUsed))
    sessionStorage.setItem('gbm-last-history-question', question.id)
    setHistoryFeedback(null)
    setHistoryQuizOpen(true)
  }

  async function answerHistoryQuiz(answer) {
    const question = HISTORY_TRIVIA.find((item) => item.id === historyQuestionId)
    if (!question) return
    if (historyQuizCooldownSeconds > 0) return
    const correct = answer === question.answer
    const cooldownUntil = Date.now() + (correct ? 25000 : 8000)
    setHistoryQuizCooldownUntil(cooldownUntil)
    window.sessionStorage.setItem('gbm-history-cooldown', String(cooldownUntil))
    setHistoryQuizOpen(false)
    if (!correct) {
      setHistoryFeedback({ type: 'wrong', text: t('phase1.historyWrong') })
      vibrateDevice()
      return
    }
    try {
      await runTransaction(ref(database, 'gameState'), (current) => {
        const currentPlayer = current?.players?.[playerId]
        if (current?.phase !== 'PHASE_1' || !currentPlayer) return undefined
        const isObserver = currentPlayer.role === 'Observer'
        const awakeningProgress = isObserver
          ? Math.min(70, Number(currentPlayer.awakeningProgress || 0) + 15)
          : Number(currentPlayer.awakeningProgress || 0)
        return {
          ...current,
          petitions: Number(current.petitions || 0) + (isObserver ? 0 : 30),
          organizationAP: adjustRoleAP(current.organizationAP, currentPlayer.role, 2),
          players: {
            ...current.players,
            [playerId]: {
              ...currentPlayer,
              ...addContribution(currentPlayer, 1, {
                quizzes: 1,
                signatures: isObserver ? 0 : 30,
              }),
              actionCount: Number(currentPlayer.actionCount || 0) + 1,
              awakeningProgress,
            },
          },
          activityFeed: {
            ...(current.activityFeed || {}),
            [push(ref(database, 'gameState/activityFeed')).key]: {
              type: 'history',
              playerName: currentPlayer.nickname,
              createdAt: Date.now(),
            },
          },
        }
      })
      if (currentRole === 'Observer') {
        showFloatingEffect('+15% awakening · +2 Group AP')
        setHistoryFeedback({ type: 'correct', text: t('phase1.observerHistoryCorrect') })
      } else {
        showFloatingEffect('+2 Group AP · +30 petitions')
        setHistoryFeedback({ type: 'correct', text: t('phase1.historyCorrect') })
      }
    } catch (quizError) {
      setHistoryFeedback({ type: 'wrong', text: `${t('phase1.historyQuizFailed')}: ${quizError.message}` })
    }
  }

  if (gameState.phase === 'FINISHED' && (!playerId || !player)) {
    return (
      <main className="min-h-[100dvh] w-full max-w-md mx-auto flex flex-col px-4 pb-8">
        <section className="card text-center">
          <h2 className="text-3xl font-black">{t('results.movementSucceeded')}</h2>
          <p className="mt-4 text-forest/70">{t('results.gameClosed')}</p>
          <p className="mt-6 rounded-2xl bg-moss p-4 font-black">{t('results.finalTrees')}: {Number(gameState.trees || 0).toLocaleString()}</p>
          <p className="mt-3 rounded-2xl bg-moss p-4 font-black">{t('results.finalSignatures')}: {Number(gameState.petitions || 0).toLocaleString()}</p>
        </section>
      </main>
    )
  }

  if (!playerId || !player) {
    return (
      <main className="min-h-[100dvh] w-full max-w-md mx-auto flex flex-col px-4 pb-8">
        <section className="card">
          <p className="mb-2 text-sm font-bold uppercase tracking-widest text-leaf">{t('player.welcome')}</p>
          <h2 className="text-4xl font-black leading-tight">{t('player.buildTitle')}<br />{t('player.growTitle')}</h2>
          <p className="mt-4 text-forest/70">{t('player.enterNickname')}</p>
          <form className="mt-8 space-y-4" onSubmit={joinLobby}>
            <label className="block text-sm font-bold" htmlFor="nickname">{t('player.nickname')}</label>
            <input id="nickname" className="w-full rounded-2xl border border-forest/15 bg-cream px-4 py-4 outline-none focus:border-leaf focus:ring-4 focus:ring-moss" maxLength={20} onChange={(event) => setNickname(event.target.value)} placeholder={t('player.nicknamePlaceholder')} value={nickname} />
            {error && <p className="text-sm font-bold text-clay">{error}</p>}
            <button className="flex w-full items-center justify-center gap-2 rounded-2xl bg-forest px-5 py-4 font-bold text-white hover:bg-leaf" type="submit">{t('player.joinLobby')} <ArrowRight size={18} /></button>
          </form>
        </section>
      </main>
    )
  }

  if (gameState.phase !== 'PHASE_1') {
    if (gameState.phase === 'FINISHED') return <PlayerResultsView gameState={gameState} playerId={playerId} />
    if (PHASE_2_PHASES.includes(gameState.phase)) return <Phase2PlayerView gameState={gameState} playerId={playerId} />
    return (
      <main className="min-h-[100dvh] w-full max-w-md mx-auto flex flex-col px-4 pb-8">
        <FinalCountdownBanner endingAt={gameState.endingAt} />
        <section className="card text-center">
          <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-moss text-forest"><Leaf size={40} /></div>
          <p className="mb-2 text-sm font-bold uppercase tracking-widest text-leaf">{t('player.youAreIn')}</p>
          <h2 className="text-3xl font-black">{t('player.hello', { name: player.nickname })}</h2>
          <p className="mt-4 text-forest/70">{gameState.phase === 'LOBBY' ? t('phase1.lobbyWaiting') : t('common.waiting')}</p>
          <p className="mt-6 rounded-2xl bg-cream p-4 font-black">{t(`phases.${gameState.phase}`)}</p>
        </section>
      </main>
    )
  }

  if (phase1State.townHallPaused) {
    return (
      <main className="min-h-[100dvh] w-full max-w-md mx-auto flex flex-col px-4 pb-8">
        <section className="card text-center">
          <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-moss text-forest"><Users size={40} /></div>
          <p className="text-sm font-bold uppercase tracking-widest text-leaf">{t('phase1.townHall')}</p>
          <h2 className="mt-2 text-4xl font-black">{t('phase1.listenAdvocates')}</h2>
          <p className="mt-4 text-forest/70">{t('phase1.townHallDescription')}</p>
          <p className="mt-6 rounded-2xl bg-cream p-4 font-bold">{t('phase1.lockedByTownHall')}</p>
        </section>
      </main>
    )
  }

  if (!currentRole) {
    return (
      <main className="min-h-[100dvh] w-full max-w-md mx-auto flex flex-col space-y-5 px-4 pb-8">
        {floatingEffect && <div className="floating-effect pointer-events-none fixed left-1/2 top-24 z-40 -translate-x-1/2 rounded-full bg-white px-5 py-3 text-xl font-black text-leaf shadow-xl">{floatingEffect}</div>}
        <FinalCountdownBanner endingAt={gameState.endingAt} />
        <section className="card">
          <p className="text-sm font-bold uppercase tracking-widest text-leaf">{t('phase1.chooseRole')}</p>
          <h2 className="mt-1 text-3xl font-black">{t('phase1.chooseRoleTitle')}</h2>
          <p className="mt-3 text-sm text-forest/70">{t('phase1.chooseRoleDescription')}</p>
          <div className="mt-6 grid gap-3">
            {ROLES.map((role) => {
              const limit = role.id === 'Observer' ? null : Number(phase1State.roleLimits?.[role.id] || 0)
              const count = roleCounts[role.id] || 0
              const full = limit !== null && count >= limit
              return (
                <button className="flex items-center justify-between rounded-2xl border border-forest/10 px-4 py-4 text-left hover:bg-moss disabled:cursor-not-allowed disabled:opacity-40" disabled={full} key={role.id} onClick={() => chooseRole(role.id)} type="button">
                  <span><span className="block font-black">{t(`roles.${role.id}.name`)}</span><span className="mt-1 block text-xs text-forest/60">{t(`roles.${role.id}.description`)}</span></span>
                  <span className={`ml-3 shrink-0 text-sm font-black ${full ? 'text-clay' : 'text-leaf'}`}>{full ? t('phase1.full') : limit === null ? t('phase1.unlimited') : `${count} / ${limit}`}</span>
                </button>
              )
            })}
          </div>
          {error && <p className="mt-4 text-sm font-bold text-clay">{error}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-lg space-y-5 px-5 pb-12">
      <FinalCountdownBanner endingAt={gameState.endingAt} />
      <section className="card">
        <div className="flex items-center justify-between">
          <div><p className="text-sm font-bold uppercase tracking-widest text-leaf">{t('player.phaseOne')} · {t(`phase1.${phase1State.substage === 'WAVE_1' ? 'waveOne' : phase1State.substage === 'WAVE_2' ? 'waveTwo' : 'waveThree'}`)}</p><h2 className="text-3xl font-black">{t('player.buildMovement')}</h2></div>
          <Sprout className="text-leaf" size={36} />
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-moss p-4"><p className="text-sm text-forest/60">{t('common.trees')}</p><p className="text-3xl font-black">{gameState.trees}</p></div>
          <div className="rounded-2xl bg-moss p-4"><p className="text-sm text-forest/60">{t('common.signatures')}</p><p className="text-3xl font-black">{gameState.petitions}</p></div>
          <div className="rounded-2xl bg-moss p-4"><p className="text-sm text-forest/60">{t('phase1.sharedSeeds')}</p><p className="text-3xl font-black">{gameState.sharedSeeds}</p></div>
        </div>
        {rallySeconds > 0 && <p className="mt-4 rounded-xl bg-leaf px-4 py-3 text-center font-black text-white">{t('player.rallyActive', { seconds: rallySeconds })}</p>}
        {momentumSeconds > 0 && <p className="mt-4 rounded-xl bg-clay px-4 py-3 text-center font-black text-white">{t('phase1.momentumBoost', { seconds: momentumSeconds })}</p>}
        <p className="mt-4 rounded-xl bg-cream px-4 py-3 text-sm font-bold text-forest/70">{t(`phase1.${phase1State.substage === 'WAVE_1' ? 'waveOneRule' : phase1State.substage === 'WAVE_2' ? 'waveTwoRule' : 'waveThreeRule'}`)}</p>
      </section>
      {phase1State.substage === 'WAVE_3' && <div className="rounded-2xl bg-clay px-5 py-4 text-center font-black text-white">{t('phase1.finalPush')}</div>}
      {gameState.emergency?.active && <section className="card border-2 border-clay bg-orange-50 text-center">
        <p className="text-sm font-black uppercase tracking-widest text-clay">{t('phase1.emergencyTitle')}</p>
        <h3 className="mt-2 text-3xl font-black text-clay">{emergencySeconds}s</h3>
        <p className="mt-2 font-bold">{t('phase1.emergencyProgress', { clicks: gameState.emergency.shieldClicks, target: 80 })}</p>
        <div className="mt-4 h-5 overflow-hidden rounded-full bg-white transition-all duration-300 ease-out"><div className="h-full rounded-full bg-clay transition-all duration-300 ease-out" style={{ width: `${Math.min(100, (gameState.emergency.shieldClicks / 80) * 100)}%` }} /></div>
        <p className="mt-4 rounded-xl bg-amber-100 px-4 py-3 font-black text-amber-950">{t('phase1.shieldLookUp')}</p>
        {shieldFeedback && <p aria-live="polite" className={`mt-3 rounded-xl px-4 py-3 font-black ${shieldFeedback.type === 'correct' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}`}>{shieldFeedback.text}{shieldLockSeconds > 0 && shieldFeedback.type === 'wrong' ? ` · ${shieldLockSeconds}s` : ''}</p>}
        <div className="mt-4 grid grid-cols-2 gap-3">{[['RED','bg-red-500'],['BLUE','bg-blue-600'],['YELLOW','bg-yellow-400'],['GREEN','bg-green-600']].map(([color, style]) => <button className={`min-h-[3.25rem] rounded-2xl px-4 py-3 text-lg font-black text-white ${style}`} disabled={shieldLockSeconds > 0 || shieldSubmitting} key={color} onClick={() => clickEmergencyShield(color)} type="button">{t(`phase1.shield.${color.toLowerCase()}`)}</button>)}</div>
      </section>}

      <section className="card">
        <p className="text-sm text-forest/60">{t('player.yourRole')}</p>
        <h3 className="mt-1 text-2xl font-black">{t(`roles.${currentRole}.name`)}</h3>
        <p className="mt-2 text-sm text-forest/70">{t(`roles.${currentRole}.description`)}</p>
        {currentRole === 'Observer' && <div className="mt-3 rounded-2xl border border-leaf/20 bg-moss p-4"><p className="text-sm font-bold text-forest/60">{t('phase1.communityNeed')}</p><p className="mt-1 text-xl font-black">{player.needType === 'WATER' ? t('phase1.needWater') : player.needType === 'FIREWOOD' ? t('phase1.needFirewood') : t('phase1.needPark')}</p></div>}
        {currentRole === 'Observer' && solutionAvailable && !player.convinced && <div className="mt-4 rounded-2xl border border-leaf/30 bg-moss p-4"><p className="font-black">{t('phase1.solutionCard')}</p><p className="mt-1 text-sm text-forest/70">{Number(player.awakeningProgress || 0) >= 70 ? t('phase1.readyForPersuasion') : t('phase1.needCampaignerPersuasion')}</p><button className="mt-4 w-full rounded-xl bg-forest px-4 py-3 font-bold text-white hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-40" disabled={Number(player.awakeningProgress || 0) < 70} onClick={convinceObserver}>{t('phase1.convinced')}</button></div>}
        {currentRole === 'Observer' && player.convinced && <button className="mt-5 w-full rounded-2xl bg-forest px-4 py-4 font-bold text-white hover:bg-leaf" onClick={() => setSelectedRole('choose')}>{t('phase1.chooseNewRole')}</button>}
        {currentRole !== 'Observer' && phase1State.allowRoleSwitch !== false && <button className="mt-5 text-sm font-bold text-leaf underline" onClick={() => setSelectedRole('choose')}>{t('player.changeRole')}</button>}
        {currentRole === 'Observer' && phase1State.allowRoleSwitch !== false && <button className="mt-5 text-sm font-bold text-leaf underline" onClick={() => setSelectedRole('choose')}>{t('player.changeRole')}</button>}
        {selectedRole && (
          <div className="mt-5 grid gap-2">
            {ROLES.filter((role) => role.id !== currentRole).map((role) => {
              const limit = role.id === 'Observer' ? null : Number(phase1State.roleLimits?.[role.id] || 0)
              const count = roleCounts[role.id] || 0
              const full = limit !== null && count >= limit
              return <button className="flex items-center justify-between rounded-xl border border-forest/10 px-4 py-3 text-left hover:bg-moss disabled:cursor-not-allowed disabled:opacity-40" disabled={full} key={role.id} onClick={() => chooseRole(role.id)}><span><span className="font-bold">{t(`roles.${role.id}.name`)}</span><span className="block text-xs text-forest/60">{t(`roles.${role.id}.description`)}</span></span><span className="ml-3 shrink-0 text-xs font-black">{full ? t('phase1.full') : limit === null ? t('phase1.unlimited') : `${count} / ${limit}`}</span></button>
            })}
          </div>
        )}
      </section>

      {currentRole === 'Tree Planter' && <section className="card relative"><h3 className="text-xl font-black">{t('phase1.plantingCycle')}</h3><p className="mt-2 text-sm text-forest/70">{t('phase1.plantingInstructions')}</p><div className="mt-5 rounded-2xl bg-cream p-4"><p className="text-sm font-bold text-forest/60">{t('phase1.currentStep', { step: plantingStep })}</p>{plantingStep === 3 && <div className="mt-3"><div className="h-4 overflow-hidden rounded-full bg-forest/10"><div className="h-full rounded-full bg-leaf transition-all" style={{ width: `${absorptionProgress}%` }} /></div><p className="mt-2 text-sm font-bold text-forest/70">{absorptionComplete ? t('phase1.absorptionComplete') : t('phase1.absorbingSoil')}</p></div>}</div><button className={`mt-5 w-full rounded-2xl px-4 py-5 text-lg font-black text-white transition ${plantingStep === 3 && !absorptionComplete ? 'cursor-wait bg-forest/40' : 'bg-leaf hover:bg-forest'}`} disabled={plantingStep === 3 && !absorptionComplete} onClick={plantingStep === 1 ? digSoil : plantingStep === 2 ? plantSeedling : harvestGrove}>{plantingStep === 1 ? t('phase1.digSoil') : plantingStep === 2 ? t('phase1.plantSeedling') : t('phase1.harvestGrowGrove')}</button>{plantingNotice && <div className="pointer-events-none absolute right-6 top-8 animate-bounce rounded-full bg-leaf px-4 py-2 text-sm font-black text-white shadow-lg">{plantingNotice}</div>}</section>}
      {currentRole === 'Community Organizer' && <section className="card"><h3 className="text-xl font-black">{t('phase1.nurtureSeedlings')}</h3><p className="mt-2 text-sm text-forest/70">{t('phase1.nurtureSeedlingsDescription')}</p><button className="mt-5 w-full rounded-2xl bg-leaf px-4 py-5 text-lg font-black text-white hover:bg-forest disabled:cursor-not-allowed disabled:opacity-40" disabled={nurtureCooldownSeconds > 0} onClick={nurtureSeedlings}>{nurtureCooldownSeconds > 0 ? t('phase1.nurtureCooldown', { seconds: nurtureCooldownSeconds }) : t('phase1.nurtureSeedlings')}</button><h3 className="mt-8 text-xl font-black">{waveRules.megaRallyUnlocked ? t('phase1.megaRally') : t('phase1.communityWorkday')}</h3><p className="mt-2 text-sm text-forest/70">{waveRules.megaRallyUnlocked ? t('phase1.megaRallyDescription') : t('phase1.communityWorkdayDescription')}</p><button className="mt-5 w-full rounded-2xl bg-forest px-4 py-5 text-lg font-black text-white hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-40" disabled={rallyCooldownSeconds > 0} onClick={launchRally}>{rallySeconds > 0 ? t('player.rallyActive', { seconds: rallySeconds }) : rallyCooldownSeconds > 0 ? t('phase1.rallyCooldown', { seconds: rallyCooldownSeconds }) : waveRules.megaRallyUnlocked ? t('phase1.megaRally') : t('phase1.communityWorkday')}</button></section>}
      {currentRole === 'Publicity Campaigner' && <section className="card">
        <h3 className="text-xl font-black">{t('phase1.challengeCounts')}</h3>
        <p className="mt-2 text-sm text-forest/70">{campaignCooldownSeconds > 0 || pitchCooldownSeconds > 0 ? t('phase1.cooldownRemaining', { seconds: Math.max(campaignCooldownSeconds, pitchCooldownSeconds) }) : t('phase1.campaignCooldown', { seconds: waveRules.campaignCooldownMs / 1000 })}</p>
        {eligibleObservers.length > 0 ? (
          <>
            <p className="mt-4 text-sm font-bold text-forest/70">{t('phase1.selectObserverFirst')}</p>
            <div className="mt-4 space-y-2">
              {eligibleObservers.map(([observerId, observer]) => {
  const needJustChanged = Date.now() - Number(observer.needChangedAt || 0) < 1000
  return (
    <button aria-pressed={selectedObserverId === observerId} className={`flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left ${selectedObserverId === observerId ? 'border-leaf bg-moss' : 'border-forest/10 bg-cream'}`} key={observerId} onClick={() => { setSelectedObserverId(observerId); setPitchFeedback('') }} type="button">
      <span>
        <span className="block font-black">{observer.nickname}</span>
        <span className={`mt-1 inline-block rounded-full px-2 py-1 text-xs text-forest/70 ${needJustChanged ? 'need-refresh' : ''}`}>{observer.needType === 'WATER' ? t('phase1.needWater') : observer.needType === 'FIREWOOD' ? t('phase1.needFirewood') : t('phase1.needPark')}</span>
        {needJustChanged && <span className="need-refresh-hint block text-xs font-bold">{t('phase1.needChangedHint')}</span>}
      </span>
      <span className="font-black text-leaf">{Number(observer.awakeningProgress || 0)}%</span>
    </button>
  )
})}
            </div>
            <div className="mt-5 grid grid-cols-1 gap-2">
              <button className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 font-bold disabled:opacity-40" disabled={!eligibleObservers.some(([observerId]) => observerId === selectedObserverId) || campaignCooldownSeconds > 0 || pitchCooldownSeconds > 0} onClick={() => pitchObserver('WATER')} type="button">{t('phase1.pitchWater')}</button>
              <button className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 font-bold disabled:opacity-40" disabled={!eligibleObservers.some(([observerId]) => observerId === selectedObserverId) || campaignCooldownSeconds > 0 || pitchCooldownSeconds > 0} onClick={() => pitchObserver('FIREWOOD')} type="button">{t('phase1.pitchFirewood')}</button>
              <button className="rounded-xl border border-leaf/30 bg-moss px-4 py-3 font-bold disabled:opacity-40" disabled={!eligibleObservers.some(([observerId]) => observerId === selectedObserverId) || campaignCooldownSeconds > 0 || pitchCooldownSeconds > 0} onClick={() => pitchObserver('PARK')} type="button">{t('phase1.pitchPark')}</button>
            </div>
          </>
        ) : remainingObservers.length === 0 ? (
          <button className="mt-5 w-full rounded-2xl border-2 border-yellow-400 bg-gradient-to-br from-yellow-100 to-amber-300 px-5 py-5 text-left shadow-lg transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50" disabled={campaignCooldownSeconds > 0 || pitchCooldownSeconds > 0} onClick={launchMassPetitionRally} type="button">
            <span className="block text-lg font-black text-amber-950">{t('phase1.massPetitionRally')}</span>
            <span className="mt-2 block text-sm font-bold text-amber-900/80">{t('phase1.massRallyDescription')}</span>
            {(campaignCooldownSeconds > 0 || pitchCooldownSeconds > 0) && <span className="mt-2 block text-sm font-black text-amber-950">{t('phase1.cooldownRemaining', { seconds: Math.max(campaignCooldownSeconds, pitchCooldownSeconds) })}</span>}
          </button>
        ) : (
          <p className="mt-5 rounded-xl bg-cream px-4 py-4 text-center text-sm font-bold text-forest/70">{t('phase1.observersChoosingRoles')}</p>
        )}
        {pitchFeedback && <p className={`mt-4 border-l-4 py-2 pl-3 text-sm font-black ${pitchFeedback === t('phase1.matchedNeed') || pitchFeedback === t('phase1.massRallySuccess') ? 'border-leaf text-leaf' : 'border-red-500 text-red-600'}`}>{pitchFeedback}</p>}
        {phase1State.bulldozer?.active && <div className="mt-5 rounded-2xl border border-clay/30 bg-orange-50 p-4"><p className="font-black text-clay">{t('phase1.bulldozer')}</p><p className="mt-1 text-sm text-forest/70">{t('phase1.bulldozerDescription')}</p><p className="mt-2 font-black text-clay">{t('phase1.truthProgress', { count: phase1State.bulldozer.truthExposes })}</p><button className="mt-3 w-full rounded-xl bg-clay px-4 py-3 font-bold text-white hover:bg-forest" onClick={exposeTruth}>{t('phase1.exposeTruth')}</button></div>}
      </section>}
      <section className="card">
        <div className="flex items-start justify-between gap-3">
          <div><h3 className="text-xl font-black">{t('phase1.historyQuiz')}</h3><p className="mt-1 text-sm text-forest/70">{t('phase1.historyQuizDescription')}</p></div>
          <span className="text-2xl">🌱</span>
        </div>
        <button className="mt-4 w-full rounded-2xl bg-forest px-4 py-4 font-black text-white hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-40" disabled={historyQuizCooldownSeconds > 0 || historyQuizOpen} onClick={openHistoryQuiz}>
          {historyQuizOpen ? t('phase1.historyQuestionOpen') : historyQuizCooldownSeconds > 0 ? t('phase1.historyCooldown', { seconds: historyQuizCooldownSeconds }) : t('phase1.historyQuiz')}
        </button>
        {historyFeedback && <div aria-live="polite" className={`mt-4 border-l-4 py-2 pl-3 text-base font-black ${historyFeedback.type === 'correct' ? 'border-leaf text-leaf' : 'border-red-500 text-red-600'}`}><span aria-hidden="true" className="mr-2">{historyFeedback.type === 'correct' ? '✅' : '❌'}</span>{historyFeedback.text}</div>}
        {historyQuizOpen && (() => {
          const question = HISTORY_TRIVIA.find((item) => item.id === historyQuestionId)
          if (!question) return null
          return (
            <div className="mt-4 rounded-2xl bg-cream p-4">
              <p className="font-black">{t(`historyQuestions.${question.id}.question`)}</p>
              <div className="mt-3 grid gap-2">
                {question.options.map((option) => (
                  <button className="rounded-xl border border-forest/10 bg-white px-3 py-3 text-left font-bold hover:bg-moss" key={option} onClick={() => answerHistoryQuiz(option)} type="button">
                    {option}. {t(`historyQuestions.${question.id}.options.${option}`)}
                  </button>
                ))}
              </div>
            </div>
          )
        })()}
      </section>
      {dualBranches.length > 0 && (
        <section className="card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-xl font-black">{t('phase1.crossRoleUpgrade')}</h3>
              <p className="mt-2 text-sm text-forest/70">{t('phase1.tripleBranchDescription')}</p>
            </div>
            <span className="shrink-0 whitespace-nowrap rounded-full bg-moss px-3 py-2 text-xs font-black leading-none text-forest sm:text-sm">
              {t('phase1.groupActionPoints', { points: currentGroupAP })}
            </span>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">
            {dualBranches.map((branch) => {
              const branchState = upgrades[branch.key]
              const level = Number(branchState.level || 0)
              const progress = Number(branchState.progress || 0)
              const required = Math.max(4, Math.ceil(Object.keys(gameState.players || {}).length * 1.2)) * (level + 1)
              return (
                <div className="rounded-2xl border border-forest/10 bg-cream p-3" key={branch.key}>
                  <p className="text-sm font-black">{t(`phase1.${branch.titleKey}`)}</p>
                  <p className="mt-1 text-xs text-forest/60">Lv.{level}/4</p>
                  <p className="mt-2 min-h-12 text-xs text-forest/70">{t(`phase1.${branch.descriptionKey}`)}</p>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
                    <div className="h-full rounded-full bg-leaf" style={{ width: `${level >= 4 ? 100 : Math.min(100, progress / required * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-right text-xs font-bold">{level >= 4 ? t('phase1.maxLevel') : `${progress} / ${required}`}</p>
                  <button className="mt-3 w-full rounded-xl bg-forest px-2 py-3 text-sm font-black text-white hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-40" disabled={currentGroupAP < 3 || level >= 4} onClick={() => supportUpgradeBranch(branch.key)} type="button">
                    {t('phase1.supportCost')}
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}
      {currentRole === 'Observer' && <section className="card"><p className="mb-3 text-right text-sm font-black text-forest">{t('phase1.groupActionPoints', { points: currentGroupAP })}</p><div className="text-center"><Users className="mx-auto text-leaf" /><p className="mt-3 text-sm text-forest/70">{t('player.phaseOneWaiting')}</p></div><div className="mt-5"><div className="flex justify-between text-sm font-bold"><span>{t('phase1.awakeningProgress')}</span><span>{Number(player.awakeningProgress || 0)}%</span></div><div className="mt-2 h-4 overflow-hidden rounded-full bg-forest/10"><div className="h-full rounded-full bg-leaf transition-all duration-300 ease-out" style={{ width: `${Math.min(100, Number(player.awakeningProgress || 0))}%` }} /></div>{Number(player.awakeningProgress || 0) >= 70 && !player.convinced && <p className="mt-3 text-center text-sm font-black text-leaf">{t('phase1.readyForPersuasion')}</p>}</div><div className="mt-5 grid gap-3 md:grid-cols-2"><button className="min-h-[3.25rem] rounded-2xl bg-clay px-4 py-3 font-black text-white disabled:cursor-not-allowed disabled:opacity-40" disabled={demandCooldownSeconds > 0} onClick={() => performObserverAction('demand')}>{demandCooldownSeconds > 0 ? t('phase1.demandCooldown', { seconds: demandCooldownSeconds }) : t('phase1.shoutNeeds')}</button><button className="min-h-[3.25rem] rounded-2xl border border-forest/15 bg-cream px-4 py-3 font-black text-forest disabled:cursor-not-allowed disabled:opacity-40" disabled={concernCooldownSeconds > 0} onClick={() => performObserverAction('concern')}>{concernCooldownSeconds > 0 ? t('phase1.concernCooldown', { seconds: concernCooldownSeconds }) : t('phase1.raiseConcern')}</button></div></section>}
      {error && <p className="text-sm font-bold text-clay">{error}</p>}
    </main>
  )
}

function ScreenView({ gameState, onReturnToLobby, isResetting, resetError }) {
  const { t } = useLanguage()
  const players = Object.values(gameState.players || {})
  const mvpPlayers = getRankedPlayers(gameState.players).slice(0, 3)
  const goals = mergeGoals(gameState.goals)
  const treeProgress = Math.min(100, (Number(gameState.trees || 0) / goals.trees) * 100)
  const forestTheme = treeProgress < 30
    ? 'bg-[#d6bc86] text-[#4a3520]'
    : treeProgress <= 70
      ? 'bg-[#a7c957] text-[#163b2a]'
      : 'bg-[#14532d] text-white shadow-[0_0_45px_rgba(74,222,128,0.55)]'
  const rallySeconds = useRallyCountdown(gameState.rally)
  const momentumSeconds = useMomentumCountdown(gameState.phase1?.momentumBoost)
  useBulldozerRegression(gameState.phase1?.bulldozer)
  const emergencySeconds = useCountdownUntil(gameState.emergency?.endsAt)
  if (gameState.phase === 'FINISHED') return <ScreenResultsView gameState={gameState} onReturnToLobby={onReturnToLobby} isResetting={isResetting} resetError={resetError} />
  if (PHASE_2_PHASES.includes(gameState.phase) || gameState.phase === 'FINAL_RESULTS') {
    return <Phase2ScreenView gameState={gameState} />
  }
  const targetColor = gameState.emergency?.targetColor
  const recentActionCount = Object.values(gameState.activityFeed || {}).filter((activity) => Date.now() - Number(activity.createdAt || 0) <= 5000).length
  const playerJoinUrl = window.location.origin
  const lobbyTreeCount = treeProgress < 30 ? 3 : treeProgress <= 70 ? 12 : 24
  const forestStatus = treeProgress < 30
    ? 'Dry & Deforested Land — Plant Trees to Restore!'
    : treeProgress <= 70
      ? 'The Forest Is Growing — Keep the Movement Moving!'
      : 'Thriving Green Belt — Celebrate the Community Legacy!'
  if (gameState.phase === 'LOBBY') {
    return (
      <main className="h-screen w-screen overflow-hidden flex flex-col p-4">
        <section className="grid min-h-0 flex-1 grid-cols-[minmax(260px,0.8fr)_minmax(420px,1.2fr)] gap-6 rounded-3xl bg-[#dbe9ca] p-6">
          <div className="flex flex-col items-center justify-center rounded-3xl bg-white/80 p-6 text-center">
            <p className="text-sm font-black uppercase tracking-[0.3em] text-leaf">LOBBY</p>
            <h2 className="mt-2 text-3xl font-black lg:text-5xl">{t('screen.joinGame')}</h2>
            <div className="mt-5 rounded-3xl bg-white p-4 shadow-xl">
              <QRCodeSVG value={playerJoinUrl} size={230} level="M" includeMargin />
            </div>
            <p className="mt-4 max-w-md break-all text-sm font-bold text-forest/70">{playerJoinUrl}</p>
          </div>
          <div className="min-h-0 overflow-hidden rounded-3xl border border-forest/10 bg-white/75 p-6">
            <div className="flex items-end justify-between">
              <div><p className="text-sm font-black uppercase tracking-widest text-leaf">{t('screen.connectedPlayersWall')}</p><h3 className="mt-1 text-3xl font-black lg:text-5xl">{players.length}</h3></div>
              <Users className="text-leaf" size={42} />
            </div>
            <div className="mt-6 grid grid-cols-3 gap-3 overflow-hidden lg:grid-cols-4 xl:grid-cols-5">
              {players.map((player, index) => <div className="rounded-2xl bg-moss px-3 py-4 text-center" key={`${player.nickname}-${index}`}><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-forest text-lg font-black text-white">{player.nickname?.slice(0, 1).toUpperCase()}</div><p className="mt-2 truncate text-sm font-black lg:text-base">{player.nickname}</p></div>)}
            </div>
            {players.length === 0 && <p className="mt-10 rounded-2xl bg-cream p-8 text-center text-forest/60">{t('screen.waitingPlayers')}</p>}
          </div>
        </section>
      </main>
    )
  }
  return (
    <main className="relative h-screen w-screen overflow-hidden flex flex-col justify-between p-4">
      <FinalCountdownBanner endingAt={gameState.endingAt} stage />
      <section className={`relative grid min-h-0 flex-[0_0_22%] grid-cols-[1fr_320px] gap-4 rounded-3xl p-4 transition-colors duration-700 ${forestTheme}`}>
        {recentActionCount > 10 && <div className="absolute left-1/2 top-2 z-30 -translate-x-1/2 animate-bounce rounded-full bg-orange-500 px-6 py-2 text-sm lg:text-xl font-black text-white shadow-2xl">🔥 COMMUNITY COMBO!</div>}
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="min-w-0"><p className="text-sm lg:text-base uppercase tracking-widest opacity-75">{t('screen.currentPhase')}</p><h2 className="truncate text-2xl font-black lg:text-4xl">{t(`phases.${gameState.phase}`)} · {t(`phase1.${gameState.phase1?.substage === 'WAVE_1' ? 'waveOne' : gameState.phase1?.substage === 'WAVE_2' ? 'waveTwo' : 'waveThree'}`)}</h2></div>
          <div className="text-right"><p className="text-2xl lg:text-4xl font-black">{players.length}</p><p className="text-xs lg:text-sm opacity-75">{t('screen.playersJoined')}</p></div>
        </div>
        <aside className="min-h-0 overflow-hidden rounded-2xl bg-black/10 p-3">
          <p className="text-xs lg:text-sm font-black uppercase tracking-widest">{t('screen.liveMvp')}</p>
          <div className="mt-2 space-y-2">{mvpPlayers.map((player, index) => <div className="flex items-center justify-between gap-3 rounded-xl bg-white/20 px-3 py-2 text-sm" key={player.id}><p className="flex min-w-0 items-center font-black"><span className="mr-1 shrink-0">{index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉'}</span><span className="truncate max-w-[120px]">{player.nickname}</span></p><p className="shrink-0 font-black">{getContributionScore(player).toLocaleString()}</p></div>)}</div>
        </aside>
      </section>

      <section className={`relative min-h-0 flex-[1_1_48%] overflow-hidden rounded-3xl ${forestTheme}`}>
        {gameState.emergency?.active ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-red-950/90 text-center text-white">
            <p className="text-xl lg:text-3xl font-black uppercase tracking-[0.35em]">{t('phase1.emergencyTitle')}</p>
            <p className="mt-2 text-6xl lg:text-8xl font-black">{emergencySeconds}s</p>
            <h2 className="mt-4 text-3xl lg:text-6xl font-black">{t('phase1.pressColor', { color: targetColor })}</h2>
            <div className="mt-6 h-5 w-[70%] overflow-hidden rounded-full bg-white/30"><div className="h-full bg-white transition-all duration-300 ease-out" style={{ width: `${Math.min(100, (gameState.emergency.shieldClicks / 80) * 100)}%` }} /></div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-between gap-4 py-6">
            <div className="flex shrink-0 justify-center gap-4 text-3xl lg:text-5xl"><span>🍃</span><span>✨</span><span>🌿</span><span>✨</span><span>🍃</span></div>
            <h2 className="z-10 rounded-2xl bg-white/35 px-5 py-3 text-center text-xl font-black shadow-sm backdrop-blur-sm lg:text-3xl">{forestStatus}</h2>
            <div className="absolute inset-x-0 bottom-0 h-[38%] overflow-hidden">
              <div className="absolute bottom-0 left-0 right-0 h-full border-t border-forest/10 bg-[linear-gradient(180deg,rgba(236,221,171,0.35),rgba(181,150,96,0.7))]" />
              <div className="absolute inset-x-0 bottom-2 grid grid-cols-12 items-end gap-1 px-4 text-3xl lg:text-4xl">
                {Array.from({ length: lobbyTreeCount }).map((_, index) => (
                  <span
                    className="origin-bottom animate-[bounce_1.8s_ease-in-out_infinite] text-center"
                    style={{ animationDelay: `${(index % 12) * 70}ms`, gridColumn: `${(index % 12) + 1}` }}
                    key={index}
                  >
                    {treeProgress < 30 ? (index % 4 === 0 ? '🌾' : index % 4 === 1 ? '🪨' : '🥀') : treeProgress <= 70 ? (index % 3 === 0 ? '🌱' : '🌿') : '🌳'}
                  </span>
                ))}
              </div>
              {treeProgress < 30 && <div className="absolute bottom-3 w-full flex justify-around items-end px-8 text-3xl lg:text-5xl"><span>🌵</span><span>🪨</span><span>🌾</span><span>🥀</span><span>🪨</span><span>🌵</span></div>}
              {treeProgress > 70 && <div className="absolute inset-x-0 top-2 flex justify-around text-2xl lg:text-4xl"><span>✨</span><span>🍃</span><span>✨</span><span>🌟</span><span>✨</span><span>🍃</span><span>✨</span></div>}
            </div>
            {rallySeconds > 0 && <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-leaf px-8 py-5 text-center text-white shadow-2xl"><p className="text-xl lg:text-3xl font-black">{rallySeconds}s</p><p className="text-xs lg:text-base">{t('screen.communityRally')}</p></div>}
            {momentumSeconds > 0 && <div className="absolute bottom-4 right-4 rounded-2xl bg-clay px-5 py-3 text-sm lg:text-xl font-black text-white">⚡ {t('phase1.momentumBoost', { seconds: momentumSeconds })}</div>}
          </div>
        )}
      </section>

      <section className="grid min-h-0 flex-[0_0_26%] grid-cols-[1fr_1fr_1.2fr] gap-3">
        <div className="min-h-0 overflow-hidden rounded-2xl bg-white/85 p-3">
          <p className="text-xs lg:text-sm font-black uppercase tracking-widest text-leaf">{t('screen.roleLevels')}</p>
          {(() => {
            const upgrades = mergeUpgrades(gameState.upgrades)
            return <div className="mt-2 space-y-1 text-xs lg:text-sm font-bold">
              <p>{t('phase1.planters')}: Tools Lv.{upgrades.planterTools.level} | Drip Lv.{upgrades.planterIrrigation.level} | Fert Lv.{upgrades.planterFertilization.level}</p>
              <p>{t('phase1.organizers')}: Greenhouse Lv.{upgrades.organizerGreenhouse.level} | Pact Lv.{upgrades.organizerPact.level} | Seed Bank Lv.{upgrades.organizerSeedBank.level}</p>
              <p>{t('phase1.campaigners')}: Megaphone Lv.{upgrades.campaignerMegaphone.level} | Grassroots Lv.{upgrades.campaignerNetwork.level} | Media Lv.{upgrades.campaignerMedia.level}</p>
            </div>
          })()}
        </div>
        <div className="min-h-0 overflow-hidden rounded-2xl bg-white/85 p-3">
          <p className="text-xs lg:text-sm font-black uppercase tracking-widest text-leaf">{t('screen.movementProgress')}</p>
          <div className="mt-2"><ProgressBar label={t('screen.treesPlanted')} value={gameState.trees} target={goals.trees} /><div className="mt-2"><ProgressBar color="bg-clay" label={t('screen.npcSignatures')} value={gameState.petitions} target={goals.petitions} /></div></div>
        </div>
        <div className="min-h-0 overflow-hidden rounded-2xl bg-white/85 p-3">
          <p className="text-xs lg:text-sm font-black uppercase tracking-widest text-clay">{t('screen.activityWall')}</p>
          <div className="mt-2 space-y-1">{Object.values(gameState.activityFeed || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 3).map((activity, index) => <p className={`truncate rounded-lg px-2 py-1 text-xs lg:text-sm font-bold ${activity.type === 'demand' && Number(activity.highlightedUntil || 0) > Date.now() ? 'animate-pulse bg-clay text-white' : 'bg-cream'}`} key={`${activity.createdAt}-${index}`}>{activity.type === 'history' ? t('phase1.historyAcedMessage', { name: activity.playerName }) : activity.type === 'demand' ? t('phase1.observerDemandMessage', { name: activity.playerName }) : activity.type === 'concern' ? t('phase1.observerConcernMessage', { name: activity.playerName }) : activity.type === 'nurture' ? t('phase1.nurturedMessage', { name: activity.playerName }) : activity.type === 'massPetition' ? t('phase1.massPetitionActivity', { name: activity.playerName }) : t('phase1.solutionMessage', { name: activity.playerName })}</p>)}</div>
        </div>
      </section>
    </main>
  )
}

function AdminView({ gameState }) {
  const { t } = useLanguage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const players = Object.values(gameState.players || {})
  const goals = mergeGoals(gameState.goals)
  const stats = useMemo(() => ({ Players: players.length, Trees: gameState.trees, Signatures: gameState.petitions }), [gameState, players.length])
  const finalCountdownSeconds = useCountdownUntil(gameState.endingAt)

  async function changeState(changes) {
    if (!database) return
    setBusy(true)
    try {
      await update(ref(database, 'gameState'), changes)
      setError('')
    } catch (stateError) {
      setError(`Unable to update game state: ${stateError.message}`)
    } finally { setBusy(false) }
  }

  async function removePlayer(playerId) {
    if (!database) return
    setBusy(true)
    try {
      await runTransaction(ref(database, 'gameState'), (current) => {
        if (!current?.players?.[playerId]) return current
        const nextPlayers = { ...current.players }
        delete nextPlayers[playerId]
        return {
          ...current,
          players: nextPlayers,
          phase1: {
            ...current.phase1,
            roleCounts: countPlayerRoles(nextPlayers),
          },
        }
      })
      setError('')
    } catch (removeError) {
      setError(`${t('admin.unableToRemove')}: ${removeError.message}`)
    } finally { setBusy(false) }
  }

  async function clearAllPlayers() {
    if (!database || !window.confirm(t('admin.confirmClearAll'))) return
    setBusy(true)
    try {
      await runTransaction(ref(database, 'gameState'), (current) => {
        if (!current) return current
        return {
          ...current,
          players: {},
          phase1: {
            ...current.phase1,
            roleCounts: { ...DEFAULT_PHASE1_STATE.roleCounts },
          },
        }
      })
      setError('')
    } catch (clearError) {
      setError(`${t('admin.unableToClear')}: ${clearError.message}`)
    } finally { setBusy(false) }
  }

  async function triggerOpposition(event) {
    if (!database) return
    setBusy(true)
    try {
      await runTransaction(ref(database, 'gameState'), (current) => {
        if (!current) return current
        const trees = Number(current.trees || 0)
        const petitions = Number(current.petitions || 0)
        const treeLoss = event.impact === 'petitions' ? 0 : Math.ceil(trees * event.ratio)
        const petitionLoss = event.impact === 'trees' ? 0 : Math.ceil(petitions * event.ratio)
        return {
          ...current,
          trees: Math.max(0, trees - treeLoss),
          petitions: Math.max(0, petitions - petitionLoss),
          oppositionEvent: { title: event.label, message: `${event.message} ${treeLoss + petitionLoss} points lost.`, createdAt: serverTimestamp() },
        }
      })
      setError('')
    } catch (eventError) {
      setError(`Unable to trigger opposition event: ${eventError.message}`)
    } finally { setBusy(false) }
  }

  async function triggerEmergency() {
    if (!database) return
    setBusy(true)
    try {
      await update(ref(database, 'gameState/emergency'), {
        active: true,
        resolved: null,
        endsAt: Date.now() + 15000,
        shieldClicks: 0,
        targetClicks: 80,
        targetColor: ['RED', 'BLUE', 'YELLOW', 'GREEN'][Math.floor(Math.random() * 4)],
      })
      setError('')
    } catch (emergencyError) {
      setError(`${t('phase1.emergencyFailed')}: ${emergencyError.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function startFinalCountdown() {
    if (!database) return
    setBusy(true)
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => {
        if (current?.phase !== 'PHASE_1' || Number(current.endingAt || 0) > 0) return undefined
        return { ...current, endingAt: Date.now() + 10000 }
      })
      if (!result.committed) {
        setError(t('admin.countdownUnavailable'))
        return
      }
      setError('')
    } catch (countdownError) {
      setError(`${t('admin.countdownUnavailable')}: ${countdownError.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function startPhase1() {
    if (!database) return
    setBusy(true)
    try {
      await runTransaction(ref(database, 'gameState'), (current) => {
        if (!current) return current
        return {
          ...current,
          phase: 'PHASE_1',
          endingAt: 0,
          finishedAt: null,
          trees: 0,
          petitions: 0,
          seeds: DEFAULT_GAME_STATE.sharedSeeds,
          sharedSeeds: DEFAULT_GAME_STATE.sharedSeeds,
          roleLevels: { ...DEFAULT_ROLE_LEVELS },
          upgrades: { ...DEFAULT_UPGRADES },
          organizationAP: { ...DEFAULT_ORGANIZATION_AP },
          emergency: { ...DEFAULT_EMERGENCY_EVENT },
          players: Object.fromEntries(Object.entries(current.players || {}).map(([playerId, player]) => [
            playerId,
            { ...player, role: null, situation: null, convinced: false, solutionReceived: false, awakeningProgress: 0, communityPoints: 0, actionCount: 0, contributionPoints: 0, contributions: {}, lastDemandAt: null, lastConcernAt: null, lastPitchAt: null, lastSolutionSentAt: null, lastNurtureAt: null, lastRallyAt: null },
          ])),
          phase1: {
            ...DEFAULT_PHASE1_STATE,
            substage: current.phase1?.substage || DEFAULT_PHASE1_STATE.substage,
            allowRoleSwitch: current.phase1?.allowRoleSwitch ?? DEFAULT_PHASE1_STATE.allowRoleSwitch,
            roleLimits: {
              ...DEFAULT_PHASE1_STATE.roleLimits,
              ...(current.phase1?.roleLimits || {}),
            },
            roleCounts: { ...DEFAULT_PHASE1_STATE.roleCounts },
            momentumBoost: { ...DEFAULT_PHASE1_STATE.momentumBoost },
            bulldozer: { ...DEFAULT_PHASE1_STATE.bulldozer },
            solutionCards: { ...DEFAULT_PHASE1_STATE.solutionCards },
          },
          rally: { active: false, endsAt: 0 },
          activityFeed: {},
        }
      })
      setError('')
    } catch (phaseError) {
      setError(`Unable to start Phase 1: ${phaseError.message}`)
    } finally { setBusy(false) }
  }

  async function changeSubstage(substage) {
    const roleLimit = substage === 'WAVE_1' ? 2 : substage === 'WAVE_2' ? 6 : 15
    await changeState({
      'phase1/substage': substage,
      'phase1/roleLimits/Tree Planter': roleLimit,
      'phase1/roleLimits/Community Organizer': roleLimit,
      'phase1/roleLimits/Publicity Campaigner': roleLimit,
    })
  }

  async function toggleTownHall() {
    const paused = gameState.phase1?.townHallPaused
    await changeState(paused
      ? {
          'phase1/townHallPaused': false,
          'phase1/momentumBoost': { active: true, endsAt: Date.now() + 30000 },
        }
      : { 'phase1/townHallPaused': true })
  }

  async function toggleBulldozer() {
    const active = gameState.phase1?.bulldozer?.active
    await changeState({
      'phase1/bulldozer': {
        active: !active,
        truthExposes: 0,
        lastTickAt: Date.now(),
      },
    })
  }

  async function resetGame() {
    if (!database) return
    setBusy(true)
    try {
      await runTransaction(ref(database, 'gameState'), (current) => {
        if (!current) return current
        return {
          ...current,
          phase: 'LOBBY',
          endingAt: 0,
          finishedAt: null,
          resetAt: Date.now(),
          trees: 0,
          seeds: DEFAULT_GAME_STATE.sharedSeeds,
          sharedSeeds: DEFAULT_GAME_STATE.sharedSeeds,
          roleLevels: { ...DEFAULT_ROLE_LEVELS },
          upgrades: { ...DEFAULT_UPGRADES },
          organizationAP: { ...DEFAULT_ORGANIZATION_AP },
          emergency: { ...DEFAULT_EMERGENCY_EVENT },
          petitions: 0,
          players: Object.fromEntries(Object.entries(current.players || {}).map(([playerId, player]) => [
            playerId,
            { ...player, role: null, situation: null, convinced: false, solutionReceived: false, awakeningProgress: 0, communityPoints: 0, actionCount: 0, contributionPoints: 0, contributions: {}, lastDemandAt: null, lastConcernAt: null, lastPitchAt: null, lastSolutionSentAt: null, lastNurtureAt: null, lastRallyAt: null },
          ])),
          rally: { active: false, endsAt: 0 },
          oppositionEvent: null,
          phase1: {
            ...DEFAULT_PHASE1_STATE,
            roleCounts: { ...DEFAULT_PHASE1_STATE.roleCounts },
            momentumBoost: { ...DEFAULT_PHASE1_STATE.momentumBoost },
            bulldozer: { ...DEFAULT_PHASE1_STATE.bulldozer },
            solutionCards: { ...DEFAULT_PHASE1_STATE.solutionCards },
          },
          activityFeed: {},
          phase2Event: null,
          indicators: DEFAULT_INDICATORS,
          roundAllocations: {},
          roundResults: {},
        }
      })
      setError('')
    } catch (resetError) {
      setError(`Unable to reset game: ${resetError.message}`)
    } finally { setBusy(false) }
  }

  async function startPhase2() {
    await changeState({
      phase: 'PHASE_2_ROUND_1',
      phase2Event: null,
      oppositionEvent: null,
      indicators: DEFAULT_INDICATORS,
      roundAllocations: {},
      roundResults: {},
    })
  }

  async function selectPhase2Event(event) {
    await changeState({
      phase2Event: { id: event.id, selectedAt: serverTimestamp() },
    })
  }

  async function calculateNextRound() {
    const round = getRoundNumber(gameState.phase)
    if (!database || !round) return
    setBusy(true)
    try {
      await runTransaction(ref(database, 'gameState'), (current) => {
        if (!current) return current
        const allocations = Object.values(current.roundAllocations?.[round] || {}).filter((allocation) => allocation.submitted)
        const event = getPhase2Event(current.phase2Event?.id)
        const totals = INDICATOR_KEYS.reduce((values, key) => ({ ...values, [key]: 0 }), {})

        allocations.forEach((allocation) => {
          ALLOCATION_ITEMS.forEach((item) => {
            const amount = Number(allocation[item.id] || 0)
            Object.entries(ACTION_EFFECTS[item.id]).forEach(([indicator, value]) => {
              totals[indicator] += amount * value
            })
          })
        })

        const indicators = { ...DEFAULT_INDICATORS, ...(current.indicators || {}) }
        const updatedIndicators = INDICATOR_KEYS.reduce((values, key) => ({
          ...values,
          [key]: Math.max(0, Math.min(100, indicators[key] + Math.round(totals[key] * (event?.effects?.[key] || 1)))),
        }), {})
        const nextPhase = round < 3 ? `PHASE_2_ROUND_${round + 1}` : 'FINAL_RESULTS'
        return {
          ...current,
          phase: nextPhase,
          phase2Event: null,
          indicators: updatedIndicators,
          roundResults: {
            ...(current.roundResults || {}),
            [round]: {
              submittedPlayers: allocations.length,
              totals,
              eventId: event?.id || null,
              calculatedAt: Date.now(),
            },
          },
        }
      })
      setError('')
    } catch (calculationError) {
      setError(`Unable to calculate round: ${calculationError.message}`)
    } finally { setBusy(false) }
  }

  const phase1State = gameState.phase1 || DEFAULT_PHASE1_STATE

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-5 pb-12">
      <section className="card">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-widest text-leaf">{t('admin.controlCenter')}</p><h2 className="text-3xl font-black">{t('admin.buildMovement')}</h2></div><span className="rounded-xl bg-moss px-4 py-3 font-black">{t(`phases.${gameState.phase}`)}</span></div>
        <button className="w-full rounded-2xl bg-forest px-5 py-5 text-lg font-black text-white hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-40" disabled={busy || gameState.phase !== 'LOBBY'} onClick={startPhase1}>{t('admin.startPhase')}</button>
        {gameState.phase === 'PHASE_1' && <button className="mt-4 w-full rounded-2xl border-2 border-red-500 bg-red-50 px-5 py-4 text-lg font-black text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy || Number(gameState.endingAt || 0) > 0} onClick={startFinalCountdown}>{Number(gameState.endingAt || 0) > 0 ? t('admin.countdownRunning', { seconds: finalCountdownSeconds }) : t('admin.startFinalCountdown')}</button>}
        <div className="mt-6 grid gap-4 sm:grid-cols-3">{Object.entries(stats).map(([label, value]) => <div className="rounded-2xl bg-moss p-5" key={label}><p className="text-sm text-forest/60">{label === 'Players' ? t('common.players') : label === 'Trees' ? t('common.trees') : t('common.signatures')}</p><p className="mt-1 text-4xl font-black">{value}</p></div>)}</div>
        <div className="mt-6">
          <p className="text-sm font-bold uppercase tracking-widest text-leaf">{t('admin.victoryGoals')}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="rounded-2xl bg-cream px-4 py-3 text-sm font-bold">{t('admin.treeGoal')}<input className="mt-2 w-full rounded-xl border border-forest/15 bg-white px-3 py-2 text-lg" disabled={busy} min="1" onChange={(event) => changeState({ 'goals/trees': Math.max(1, Number(event.target.value)) })} type="number" value={goals.trees} /></label>
            <label className="rounded-2xl bg-cream px-4 py-3 text-sm font-bold">{t('admin.petitionGoal')}<input className="mt-2 w-full rounded-xl border border-forest/15 bg-white px-3 py-2 text-lg" disabled={busy} min="1" onChange={(event) => changeState({ 'goals/petitions': Math.max(1, Number(event.target.value)) })} type="number" value={goals.petitions} /></label>
          </div>
        </div>
        <button className="mt-6 flex items-center gap-2 rounded-xl border border-clay/30 px-4 py-3 font-bold text-clay hover:bg-orange-50" disabled={busy} onClick={resetGame}><RotateCcw size={17} /> {t('phase1.resetGame')}</button>
      </section>
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-sm font-bold uppercase tracking-widest text-leaf">{t('admin.connectedPlayers')}</p><h3 className="mt-1 text-2xl font-black">{t('admin.playerList')}</h3></div>
          <button className="rounded-xl border border-clay/30 px-4 py-2 text-sm font-bold text-clay hover:bg-orange-50" disabled={busy || players.length === 0 || gameState.phase === 'FINISHED'} onClick={clearAllPlayers}>{t('admin.clearAllPlayers')}</button>
        </div>
        <div className="mt-5 space-y-3">
          {players.length === 0 ? <p className="rounded-2xl bg-cream p-6 text-center text-forest/60">{t('admin.noConnectedPlayers')}</p> : Object.entries(gameState.players || {}).map(([playerId, player]) => <div className="flex items-center justify-between gap-3 rounded-2xl bg-cream px-4 py-3" key={playerId}><div><p className="font-black">{player.nickname}</p><p className="text-sm text-forest/60">{player.role ? t(`roles.${player.role}.name`) : t('phase1.notSelected')}</p></div><button className="rounded-xl bg-clay px-3 py-2 text-xs font-black text-white hover:bg-forest disabled:opacity-40" disabled={busy || gameState.phase === 'FINISHED'} onClick={() => removePlayer(playerId)}>{t('admin.kickRemove')}</button></div>)}
        </div>
        {error && <p className="mt-4 rounded-xl bg-orange-50 px-4 py-3 text-sm font-bold text-clay">{error}</p>}
      </section>
      {(gameState.phase === 'LOBBY' || gameState.phase === 'PHASE_1') && (
        <section className="card">
          <p className="text-sm font-bold uppercase tracking-widest text-leaf">{t('phase1.substageControls')}</p>
          <p className="mt-2 text-sm text-forest/70">{t('phase1.automaticAssignment')}</p>
          <div className="mt-5">
            <p className="text-sm font-bold text-forest/70">{t('phase1.roleLimits')}</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {['Tree Planter', 'Community Organizer', 'Publicity Campaigner'].map((role) => <label className="rounded-2xl bg-cream px-4 py-3 text-sm font-bold" key={role}>{t(`roles.${role}.name`)}<input className="mt-2 w-full rounded-xl border border-forest/15 bg-white px-3 py-2 text-lg" disabled={busy} min="0" onChange={(event) => changeState({ [`phase1/roleLimits/${role}`]: Math.max(0, Number(event.target.value)) })} type="number" value={phase1State.roleLimits?.[role] ?? 2} /></label>)}
            </div>
          </div>
          <button
            className={`mt-5 w-full rounded-2xl px-4 py-4 text-left font-bold ${phase1State.allowRoleSwitch !== false ? 'border border-leaf bg-moss' : 'border border-forest/10 hover:bg-cream'}`}
            disabled={busy}
            onClick={() => changeState({ 'phase1/allowRoleSwitch': phase1State.allowRoleSwitch === false })}
            type="button"
          >
            {t('admin.allowRoleSwitch')}
            <span className="mt-1 block text-xs font-normal text-forest/60">{phase1State.allowRoleSwitch !== false ? t('admin.roleSwitchOn') : t('admin.roleSwitchOff')}</span>
          </button>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {PHASE_1_SUBSTAGES.map((substage, index) => <button className={`rounded-2xl border px-4 py-4 text-left font-bold ${phase1State.substage === substage ? 'border-leaf bg-moss' : 'border-forest/10 hover:bg-cream'}`} disabled={busy} key={substage} onClick={() => changeSubstage(substage)}>{gameState.phase === 'LOBBY' ? t('phase1.setStartWave', { wave: index + 1 }) : t('phase1.startWave', { wave: index + 1 })}<span className="mt-1 block text-xs font-normal text-forest/60">{t(`phase1.${substage === 'WAVE_1' ? 'waveOne' : substage === 'WAVE_2' ? 'waveTwo' : 'waveThree'}`)}</span><span className="mt-2 block text-xs font-normal text-forest/70">{t(`phase1.${substage === 'WAVE_1' ? 'waveOneRule' : substage === 'WAVE_2' ? 'waveTwoRule' : 'waveThreeRule'}`)}</span></button>)}
          </div>
          {gameState.phase === 'PHASE_1' && <div className="mt-6 grid gap-3 md:grid-cols-2">
            <button className={`rounded-2xl px-4 py-4 text-left font-bold ${phase1State.townHallPaused ? 'bg-clay text-white' : 'border border-forest/10 hover:bg-cream'}`} disabled={busy} onClick={toggleTownHall}>{phase1State.townHallPaused ? t('phase1.resumeTownHall') : t('phase1.pauseTownHall')}<span className="mt-1 block text-xs font-normal opacity-75">{t('phase1.townHallDescription')}</span></button>
            <button className={`rounded-2xl px-4 py-4 text-left font-bold ${phase1State.bulldozer?.active ? 'bg-clay text-white' : 'border border-clay/30 text-clay hover:bg-orange-50'}`} disabled={busy} onClick={toggleBulldozer}>{phase1State.bulldozer?.active ? t('phase1.deactivateBulldozer') : t('phase1.activateBulldozer')}<span className="mt-1 block text-xs font-normal opacity-75">{t('phase1.bulldozerDescription')}</span></button>
          </div>}
        </section>
      )}
      {gameState.phase === 'PHASE_1' && <section className="card">
        <div className="mb-5"><p className="text-sm font-bold uppercase tracking-widest text-clay">{t('admin.oppositionEvents')}</p><h3 className="text-2xl font-black">{t('admin.triggerWarning')}</h3></div>
        <button className="mb-4 w-full rounded-2xl border-2 border-clay bg-orange-50 px-5 py-4 font-black text-clay hover:bg-clay hover:text-white active:scale-95" disabled={busy || gameState.emergency?.active} onClick={triggerEmergency}>{gameState.emergency?.active ? t('phase1.emergencyActive') : t('admin.triggerEmergency')}</button>
        <div className="grid gap-3 md:grid-cols-3">{OPPOSITION_EVENTS.map((event) => <button className="rounded-2xl border border-clay/30 px-4 py-4 text-left font-bold text-clay hover:bg-orange-50" disabled={busy} key={event.id} onClick={() => triggerOpposition(event)}><AlertTriangle className="mb-3" size={20} /><span>{t(`admin.${event.id === 'deforestation' ? 'deforestation' : event.id === 'misinformation' ? 'misinformation' : 'politicalPressure'}`)}</span><span className="mt-1 block text-xs font-normal text-forest/60">{event.impact === 'both' ? t('admin.reduceBoth', { percentage: event.ratio * 100 }) : t('admin.reduce', { target: t(`common.${event.impact}`), percentage: event.ratio * 100 })}</span></button>)}</div>
        <button className="mt-6 flex items-center gap-2 rounded-xl border border-clay/30 px-4 py-3 font-bold text-clay hover:bg-orange-50 disabled:opacity-40" disabled={busy} onClick={resetGame}><RotateCcw size={17} /> {t('common.reset')}</button>
      </section>}
    </main>
  )
}

function HostStageGate({ requestedRole, onVerified }) {
  const { t } = useLanguage()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')

  function submitPin(event) {
    event.preventDefault()
    if (pin.trim() !== HOST_PIN) {
      setError(t('gate.invalidPin'))
      return
    }
    window.sessionStorage.setItem('isVerifiedHost', 'true')
    setError('')
    onVerified(requestedRole)
  }

  function backToPlayer() {
    window.history.replaceState({}, '', window.location.pathname)
    window.location.reload()
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-lg items-center px-5">
      <section className="card w-full text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-moss text-forest"><Users size={30} /></div>
        <h2 className="text-3xl font-black">{t('gate.title')}</h2>
        <p className="mt-3 text-sm text-forest/60">{t('gate.description')}</p>
        <form className="mt-6 space-y-4" onSubmit={submitPin}>
          <label className="sr-only" htmlFor="host-pin">{t('gate.pinLabel')}</label>
          <input
            id="host-pin"
            className="w-full rounded-2xl border border-forest/15 bg-cream px-4 py-4 text-center text-2xl font-black tracking-[0.35em] outline-none focus:border-leaf focus:ring-4 focus:ring-moss"
            inputMode="numeric"
            maxLength={12}
            onChange={(event) => setPin(event.target.value)}
            placeholder="• • • •"
            type="password"
            value={pin}
          />
          {error && <p className="rounded-xl bg-red-50 px-4 py-3 font-bold text-red-600">{error}</p>}
          <button className="w-full rounded-2xl bg-forest px-5 py-4 font-black text-white active:scale-95" type="submit">{t('gate.confirm')}</button>
          <button className="w-full rounded-2xl border border-forest/15 px-5 py-3 font-bold text-forest active:scale-95" onClick={backToPlayer} type="button">{t('gate.backToPlayer')}</button>
        </form>
      </section>
    </main>
  )
}

function AppContent() {
  const { t } = useLanguage()
  const query = new URLSearchParams(window.location.search)
  const access = query.get('access')
  const requestedRole = query.has('host') || access === 'gbm-host'
    ? 'admin'
    : query.has('screen') || access === 'gbm-stage'
      ? 'screen'
      : 'player'
  const [verifiedRole, setVerifiedRole] = useState(() => (
    window.sessionStorage.getItem('isVerifiedHost') === 'true' ? requestedRole : ''
  ))
  const [stageResetting, setStageResetting] = useState(false)
  const [stageResetError, setStageResetError] = useState('')
  const activeRole = requestedRole === 'player' ? 'player' : verifiedRole === requestedRole ? requestedRole : 'gate'
  const { gameState, connectionError } = useGameState()
  useEmergencyResolution(gameState.emergency)
  usePhase1AutoFinish(gameState)
  useSeedBank(gameState.upgrades)

  async function returnStageToLobby() {
    if (!database || stageResetting || !window.confirm(t('results.confirmReset'))) return
    setStageResetting(true)
    setStageResetError('')
    try {
      const result = await runTransaction(ref(database, 'gameState'), (current) => (
        current ? { ...DEFAULT_GAME_STATE, resetAt: Date.now() } : current
      ))
      if (!result.committed) throw new Error(t('results.resetNotCommitted'))
    } catch (resetError) {
      setStageResetError(t('results.resetFailed', { message: resetError.message }))
    } finally {
      setStageResetting(false)
    }
  }

  if (activeRole === 'screen') {
    return (
      <div className={gameState.emergency?.active ? 'emergency-flash h-screen w-screen overflow-hidden' : 'h-screen w-screen overflow-hidden'}>
        <LanguageToggle />
        <ScreenView
          gameState={gameState}
          isResetting={stageResetting}
          onReturnToLobby={returnStageToLobby}
          resetError={stageResetError}
        />
      </div>
    )
  }

  return (
    <div className={gameState.emergency?.active ? 'emergency-flash min-h-screen' : 'min-h-screen'}>
      <Header role={activeRole === 'gate' ? 'player' : activeRole} />
      <LanguageToggle />
      <FirebaseNotice connectionError={connectionError} />
      <OppositionBanner event={gameState.oppositionEvent} />
      {activeRole === 'gate' && <HostStageGate requestedRole={requestedRole} onVerified={setVerifiedRole} />}
      {activeRole === 'screen' && <ScreenView gameState={gameState} />}
      {activeRole === 'admin' && <AdminView gameState={gameState} />}
      {activeRole === 'player' && <PlayerView gameState={gameState} />}
    </div>
  )
}

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  )
}
