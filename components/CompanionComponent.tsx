'use client'

import { Orb } from '@/components/ui/orb' // <-- IMPORT CORRECTO del Orb de ElevenLabs UI
import { cn, configureAssistant, getSubjectColor } from '@/lib/utils'
import { vapi } from '@/lib/vapi.sdk'
import Image from 'next/image'
import React, { useEffect, useRef, useState } from 'react'

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
  const [agentState, setAgentState] = useState<AgentState>(null)

  // =========================
  // AUDIO -> ORB
  // =========================
  // volumen crudo que llega del SDK (0..1)
  const rawVolRef = useRef(0)
  // volumen suavizado que consume el Orb
  const smoothVolRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  // debug opcional
  const [debugVol, setDebugVol] = useState(0)

  // smoothing en RAF
  useEffect(() => {
    const tick = () => {
      const target = rawVolRef.current
      const attack = 0.35
      const decay = 0.12
      const speed = target > smoothVolRef.current ? attack : decay

      smoothVolRef.current += (target - smoothVolRef.current) * speed
      // cap para no llegar a 1.0 (se ve mejor)
      const capped = Math.min(0.85, Math.max(0, smoothVolRef.current))
      smoothVolRef.current = capped
      setDebugVol(capped)

      // Cambiamos el estado visual del agente (opcional, queda más “vivo”)
      setAgentState(capped > 0.06 ? 'talking' : null)

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // suscribir volumen del SDK (evento volume-level de Vapi)
  useEffect(() => {
    const onVol = (vol: number) => {
      // normaliza/boost leve y clamp
      const v = Math.max(0, Math.min(1, vol * 1.2))
      rawVolRef.current = v
    }
    vapi.on('volume-level', onVol)
    return () => {
      vapi.off('volume-level', onVol)
    }
  }, [])

  const getInputVolume = () => 0 // no usamos mic
  const getOutputVolume = () => smoothVolRef.current

  // =========================
  // EVENTOS DE LA LLAMADA
  // =========================
  useEffect(() => {
    const onCallStart = () => setCallStatus(CallStatus.ACTIVE)
    const onCallEnd = () => {
      setCallStatus(CallStatus.FINISHED)
      setAgentState(null)
      rawVolRef.current = 0
      smoothVolRef.current = 0
      setDebugVol(0)
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

    vapi.on('call-start', onCallStart)
    vapi.on('call-end', onCallEnd)
    vapi.on('message', onMessage)
    vapi.on('error', (err: Error) => console.log('Error:', err))
    vapi.on('speech-start', () => setAgentState('talking'))
    vapi.on('speech-end', () => setAgentState(null))

    return () => {
      vapi.off('call-start', onCallStart)
      vapi.off('call-end', onCallEnd)
      vapi.off('message', onMessage)
      vapi.off('error', (err: Error) => console.log('Error:', err))
      vapi.off('speech-start', () => setAgentState('talking'))
      vapi.off('speech-end', () => setAgentState(null))
    }
  }, [])

  // =========================
  // CONTROLES MICRO/SESIÓN
  // =========================
  const toggleMicrophone = () => {
    const muted = vapi.isMuted()
    vapi.setMuted(!muted)
    setIsMuted(!muted)
  }

  const handleCall = async () => {
    setCallStatus(CallStatus.CONNECTING)
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
  }

  // =========================
  // UI
  // =========================
  return (
    <section className='flex flex-col h-[70vh]'>
      <section className='flex gap-8 max-sm:flex-col'>
        <div className='companion-section'>
          <div
            className='companion-avatar relative'
            style={{ backgroundColor: getSubjectColor(subject) }}
          >
            {/* Ícono cuando inactivo/terminado */}
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

            {/* Orb cuando ACTIVO */}
            <div
              className={cn(
                'absolute inset-0 grid place-items-center transition-opacity duration-1000',
                callStatus === CallStatus.ACTIVE ? 'opacity-100' : 'opacity-0'
              )}
            >
              <div className='w-[170px] h-[170px]'>
                <Orb
                  // props de audio reactivity por función (doc oficial)
                  getInputVolume={getInputVolume}
                  getOutputVolume={getOutputVolume}
                  // estado visual del agente (opcional, mejora la percepción)
                  agentState={agentState}
                  // si quieres forzar colores:
                  // colors={["#CADCFC", "#A0B9D1"]}
                  // seed={1234}
                />
              </div>

              {/* Debug: quítalo cuando confirmes que sube */}
              <div className='absolute bottom-2 text-xs bg-black/50 text-white px-2 py-1 rounded'>
                vol: {debugVol.toFixed(2)}
              </div>
            </div>
          </div>
          <p className='font-bold text-2xl'>{name}</p>
        </div>

        <div className='user-section'>
          <div className='user-avatar'>
            <Image
              src={userImage}
              alt={userName}
              width={130}
              height={130}
              className='rounded-lg'
            />
            <p className='font-bold text-2xl'>{userName}</p>
          </div>

          <button
            className='btn-mic'
            onClick={toggleMicrophone}
            disabled={callStatus !== CallStatus.ACTIVE}
          >
            <Image
              src={isMuted ? '/icons/mic-off.svg' : '/icons/mic-on.svg'}
              alt={isMuted ? 'Unmute' : 'Mute'}
              width={36}
              height={36}
            />
            <p className='max-sm:hidden '>
              {isMuted ? 'Turn on microphone' : 'Turn off microphone'}
            </p>
          </button>

          <button
            className={cn(
              'rounded-lg py-2 cursor-pointer transition-colors w-full text-white',
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
        <div className='transcript-fade' />
      </section>
    </section>
  )
}

export default CompanionComponent
