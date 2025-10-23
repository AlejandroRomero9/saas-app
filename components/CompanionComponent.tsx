'use client'

import { LiveWaveform } from '@/components/ui/live-waveform'
import { Orb } from '@/components/ui/orb'
import { addToSessionHistory } from '@/lib/actions/companion.actions'
import { cn, configureAssistant, getSubjectColor } from '@/lib/utils'
import { vapi } from '@/lib/vapi.sdk'
import Image from 'next/image'
import React, { useEffect, useMemo, useRef, useState } from 'react'

interface SavedMessage {
  role: 'assistant' | 'user'
  content: string
}
interface Message {
  type: 'transcript' | string
  transcriptType?: 'final' | 'partial'
  role: 'assistant' | 'user'
  transcript?: string
}

interface CompanionComponentProps {
  companionId: string
  subject: string
  topic: string
  name: string
  userName: string
  userImage: string
  style?: string
  voice?: string
}

enum CallStatus {
  INACTIVE = 'INACTIVE',
  CONNECTING = 'CONNECTING',
  ACTIVE = 'ACTIVE',
  FINISHED = 'FINISHED'
}

type AgentState = null | 'thinking' | 'listening' | 'talking'

function lighten(hex: string, amt = 0.2) {
  const n = hex.replace('#', '')
  const r = parseInt(n.slice(0, 2), 16)
  const g = parseInt(n.slice(2, 4), 16)
  const b = parseInt(n.slice(4, 6), 16)
  const L = (x: number) =>
    Math.min(255, Math.max(0, Math.round(x + (255 - x) * amt)))
  const toHex = (x: number) => x.toString(16).padStart(2, '0')
  return `#${toHex(L(r))}${toHex(L(g))}${toHex(L(b))}`
}

const CompanionComponent = ({
  companionId,
  subject,
  topic,
  name,
  userName,
  userImage,
  style,
  voice
}: CompanionComponentProps) => {
  const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.INACTIVE)
  const [isMuted, setIsMuted] = useState<boolean>(false)
  const [messages, setMessages] = useState<SavedMessage[]>([])
  const [, setAgentState] = useState<AgentState>(null)

  // ========= ORB (salida del agente) =========
  const rawVolRef = useRef(0)
  const smoothVolRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const [, setDebugVol] = useState(0)

  // Estados/refs de Orb “avanzado”
  const [orbState, setOrbState] = useState<null | 'listening' | 'talking'>(null)
  const colorsRef = useRef<string[] | null>(null)
  const orbSeedRef = useRef<number>(Math.floor(Math.random() * 10_000))

  // Paletas para listening/talking en base al subject color
  const base = getSubjectColor(subject)
  const listeningColors = useMemo(
    () => [lighten(base, 0.35), lighten(base, 0.15)],
    [base]
  )
  const talkingColors = useMemo(() => {
    const warm = '#FF7A59'
    return [warm, lighten(warm, 0.25)]
  }, [])

  // smoothing del volumen (para que el orb “respire” al hablar el agente)
  useEffect(() => {
    const tick = () => {
      const target = rawVolRef.current
      const attack = 0.35
      const decay = 0.12
      const speed = target > smoothVolRef.current ? attack : decay
      smoothVolRef.current += (target - smoothVolRef.current) * speed
      const capped = Math.min(0.85, Math.max(0, smoothVolRef.current))
      smoothVolRef.current = capped
      setDebugVol(capped)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    const onVol = (vol: number) => {
      const v = Math.max(0, Math.min(1, vol * 1.2))
      rawVolRef.current = v
    }
    vapi.on('volume-level', onVol)
    return () => {
      vapi.off('volume-level', onVol)
    }
  }, [])

  // ========= LiveWaveform =========
  // se enciende solo cuando inicias sesión y se apaga al mutear/colgar
  const [waveActive, setWaveActive] = useState(false)

  useEffect(() => {
    const onCallStart = () => {
      setCallStatus(CallStatus.ACTIVE)
      setWaveActive((prev) => prev || !isMuted)
    }
    const onCallEnd = () => {
      setCallStatus(CallStatus.FINISHED)
      setAgentState(null)
      rawVolRef.current = 0
      smoothVolRef.current = 0
      setDebugVol(0)
      setWaveActive(false)
      addToSessionHistory(companionId)
    }
    const onMessage = (message: Message) => {
      if (
        message.type === 'transcript' &&
        message.transcriptType === 'final' &&
        message.transcript
      ) {
        const newMessage = { role: message.role, content: message.transcript }
        setMessages((prev) => [newMessage, ...prev])
      }
    }
    const onError = (err: Error) => console.log('Error:', err)
    const onSpeechStart = () => setAgentState('talking')
    const onSpeechEnd = () => setAgentState(null)

    vapi.on('call-start', onCallStart)
    vapi.on('call-end', onCallEnd)
    vapi.on('message', onMessage)
    vapi.on('error', onError)
    vapi.on('speech-start', onSpeechStart)
    vapi.on('speech-end', onSpeechEnd)

    return () => {
      vapi.off('call-start', onCallStart)
      vapi.off('call-end', onCallEnd)
      vapi.off('message', onMessage)
      vapi.off('error', onError)
      vapi.off('speech-start', onSpeechStart)
      vapi.off('speech-end', onSpeechEnd)
    }
  }, [isMuted])

  // ========= Máquina de estados del Orb (listening/talking) =========
  useEffect(() => {
    const TALK_ON = 0.07
    const TALK_OFF = 0.05

    let raf: number | null = null
    let current: null | 'listening' | 'talking' = null

    const step = () => {
      const out = smoothVolRef.current
      const agentTalking =
        current === 'talking' ? out > TALK_OFF : out > TALK_ON

      let next: null | 'listening' | 'talking' = null
      if (agentTalking) {
        next = 'talking'
      } else if (callStatus === CallStatus.ACTIVE && !isMuted && waveActive) {
        next = 'listening'
      } else {
        next = null
      }

      if (next !== current) {
        current = next
        setOrbState(next)

        colorsRef.current =
          next === 'talking'
            ? talkingColors
            : next === 'listening'
            ? listeningColors
            : listeningColors
      }

      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [callStatus, isMuted, waveActive, listeningColors, talkingColors])

  // ========= Getters para el Orb =========

  const getInputVolume = () => {
    if (orbState === 'listening') {
      const t = performance.now() / 600
      return 0.085 + Math.sin(t) * 0.035 // 0.05–0.12 aprox
    }
    return 0
  }
  const getOutputVolume = () => smoothVolRef.current

  // ========= Controles mic/sesión =========
  const toggleMicrophone = () => {
    const muted = vapi.isMuted()
    vapi.setMuted(!muted)
    setIsMuted(!muted)

    if (!muted) {
      setWaveActive(false)
    } else if (callStatus === CallStatus.ACTIVE) {
      setWaveActive(true)
    }
  }

  const handleCall = async () => {
    setCallStatus(CallStatus.CONNECTING)
    setWaveActive(true)

    const assistantOverrides = {
      variableValues: { subject, topic, style },
      clientMessages: ['transcript'],
      serverMessages: []
    }
    // @ts-expect-error: tipado de start puede variar
    vapi.start(configureAssistant(voice, style), assistantOverrides)
  }

  const handleDisconnect = () => {
    setCallStatus(CallStatus.FINISHED)
    vapi.stop()
    setWaveActive(false)
  }

  return (
    <section className='flex flex-col h-[70vh]'>
      <section className='flex gap-8 max-sm:flex-col'>
        <div className='companion-section'>
          <div
            className='companion-avatar relative'
            style={{ backgroundColor: getSubjectColor(subject) }}
          >
            <div
              className={cn(
                'absolute inset-0 grid place-items-center transition-opacity duration-1000',
                callStatus === CallStatus.FINISHED ||
                  callStatus === CallStatus.INACTIVE
                  ? 'opacity-100'
                  : 'opacity-0',
                callStatus === CallStatus.CONNECTING &&
                  'opacity-100 animate-pulse'
              )}
            >
              <Image
                src={`/icons/${subject}.svg`}
                alt={subject}
                width={150}
                height={150}
                className='max-sm:w-fit'
              />
            </div>
            <div
              className={cn(
                'absolute inset-0 grid place-items-center transition-opacity duration-1000',
                callStatus === CallStatus.ACTIVE ? 'opacity-100' : 'opacity-0'
              )}
            >
              <div className='w-[170px] h-[170px]'>
                <Orb
                  getInputVolume={getInputVolume}
                  getOutputVolume={getOutputVolume}
                  agentState={orbState}
                  seed={orbSeedRef.current}
                />
              </div>
            </div>
          </div>
          <p className='font-bold text-2xl'>{name}</p>
        </div>

        <div className='user-section w-full max-w-xs'>
          <div className='user-avatar flex items-center gap-3'>
            <Image
              src={userImage}
              alt={userName}
              width={60}
              height={60}
              className='rounded-lg'
            />
            <p className='font-bold text-xl'>{userName}</p>
          </div>

          <div className='mt-4 w-full rounded-xl border border-neutral-200 bg-white/60 p-3 shadow-sm'>
            <LiveWaveform
              key={`wf-${waveActive}-${isMuted}-${callStatus}`}
              active={
                waveActive && callStatus === CallStatus.ACTIVE && !isMuted
              }
              processing={callStatus === CallStatus.CONNECTING}
              mode='static'
            />

            <button
              className={cn(
                'mt-3 rounded-lg py-2 cursor-pointer transition-colors w-full text-white',
                callStatus === CallStatus.ACTIVE
                  ? isMuted
                    ? 'bg-neutral-500'
                    : 'bg-red-700'
                  : 'bg-neutral-400',
                callStatus === CallStatus.CONNECTING && 'animate-pulse'
              )}
              onClick={toggleMicrophone}
              disabled={callStatus !== CallStatus.ACTIVE}
            >
              {isMuted ? 'Turn on microphone' : 'Turn off microphone'}
            </button>
          </div>

          <button
            className={cn(
              'mt-3 rounded-lg py-2 cursor-pointer transition-colors w-full text-white',
              callStatus === CallStatus.ACTIVE ? 'bg-red-700 ' : 'bg-primary',
              callStatus === CallStatus.CONNECTING && 'animate-pulse'
            )}
            onClick={
              callStatus === CallStatus.ACTIVE ? handleDisconnect : handleCall
            }
          >
            {callStatus === CallStatus.ACTIVE
              ? 'End Session'
              : callStatus === CallStatus.CONNECTING
              ? 'Connecting...'
              : 'Start Session'}
          </button>
        </div>
      </section>

      <section className='transcript'>
        <div className='transcript-message no-scrollbar'>
          {messages.map((message, index) => {
            if (message.role === 'assistant') {
              return (
                <p
                  key={index}
                  className='max-sm:text-sm'
                >
                  {name.split(' ')[0].replace(/[.,]/g, '')}: {message.content}
                </p>
              )
            } else {
              return (
                <p
                  key={index}
                  className='text-primary max-sm:text-sm'
                >
                  {userName}: {message.content}
                </p>
              )
            }
          })}
        </div>
        {/* <div className='transcript-fade' /> */}
      </section>
    </section>
  )
}

export default CompanionComponent
