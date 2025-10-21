'use client'

import { LiveWaveform } from '@/components/ui/live-waveform'
import { Orb } from '@/components/ui/orb'
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

  // ========= ORB (salida del agente) =========
  const rawVolRef = useRef(0) // 0..1 desde SDK (evento 'volume-level')
  const smoothVolRef = useRef(0) // suavizado para animación
  const rafRef = useRef<number | null>(null)
  const [debugVol, setDebugVol] = useState(0)

  // smoothing del volumen (para que el orb “respire”)
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
      setAgentState(capped > 0.06 ? 'talking' : null)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // suscripción al volumen del asistente
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

  const getInputVolume = () => 0 // el Orb no usa tu mic
  const getOutputVolume = () => smoothVolRef.current

  // ========= LiveWaveform (tu voz) =========
  // se enciende solo cuando tú inicias sesión (click) y se apaga al colgar/mutear
  const [waveActive, setWaveActive] = useState(false)

  // ========= Eventos de la llamada, transcript, etc. =========
  useEffect(() => {
    const onCallStart = () => {
      setCallStatus(CallStatus.ACTIVE)
      // OPCIONAL: encender wave al empezar si no está muteado
      setWaveActive((prev) => prev || !isMuted)
    }
    const onCallEnd = () => {
      setCallStatus(CallStatus.FINISHED)
      setAgentState(null)
      rawVolRef.current = 0
      smoothVolRef.current = 0
      setDebugVol(0)
      // apagar wave al terminar
      setWaveActive(false)
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

  // ========= Controles mic/sesión =========
  const toggleMicrophone = () => {
    const muted = vapi.isMuted()
    vapi.setMuted(!muted)
    setIsMuted(!muted)
    // si muteas, apaga el wave; si desmuteas y la call sigue activa, vuelve a encender
    if (!muted) {
      setWaveActive(false)
    } else if (callStatus === CallStatus.ACTIVE) {
      setWaveActive(true)
    }
  }

  const handleCall = async () => {
    setCallStatus(CallStatus.CONNECTING)

    // Encender el waveform desde el click (user gesture),
    // algunos navegadores lo prefieren para abrir el mic sin fricciones.
    setWaveActive(true)

    const assistantOverrides = {
      variableValues: { subject, topic, style },
      clientMessages: ['transcript'],
      serverMessages: []
    }
    // @ts-expect-error: tipado de start puede variar según tu SDK
    vapi.start(configureAssistant(voice, style), assistantOverrides)
  }

  const handleDisconnect = () => {
    setCallStatus(CallStatus.FINISHED)
    vapi.stop()
    // apagar el waveform
    setWaveActive(false)
  }

  return (
    <section className='flex flex-col h-[70vh]'>
      <section className='flex gap-8 max-sm:flex-col'>
        {/* LADO AGENTE */}
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
                  getInputVolume={getInputVolume}
                  getOutputVolume={getOutputVolume}
                  agentState={agentState}
                />
              </div>
              {/* Debug: quítalo si no lo quieres */}
              <div className='absolute bottom-2 text-xs bg-black/50 text-white px-2 py-1 rounded'>
                vol: {debugVol.toFixed(2)}
              </div>
            </div>
          </div>
          <p className='font-bold text-2xl'>{name}</p>
        </div>

        {/* LADO USUARIO */}
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

          {/* Waveform TU MIC - wave arriba, botón abajo */}
          <div className='mt-4 w-full rounded-xl border border-neutral-200 bg-white/60 p-3 shadow-sm'>
            <LiveWaveform
              key={`wf-${waveActive}-${isMuted}-${callStatus}`}
              // Solo activo si: lo encendiste, la call está activa y no estás muteado
              active={
                waveActive && callStatus === CallStatus.ACTIVE && !isMuted
              }
              // Muestra animación de “procesando” durante CONNECTING
              processing={callStatus === CallStatus.CONNECTING}
              // Visual y respuesta
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

          {/* Botón de llamar/colgar */}
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

      {/* TRANSCRIPCIÓN */}
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
