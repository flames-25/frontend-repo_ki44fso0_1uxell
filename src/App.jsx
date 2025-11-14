import { useEffect, useRef, useState } from 'react'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

import { createClient } from '@supabase/supabase-js'
const supabase = createClient(supabaseUrl, supabaseKey)

function VideoOverlay({ farmerName, vehicleNumber }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const [streamActive, setStreamActive] = useState(false)

  useEffect(() => {
    return () => {
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = videoRef.current.srcObject.getTracks()
        tracks.forEach((t) => t.stop())
      }
    }
  }, [])

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        setStreamActive(true)
      }
    } catch (e) {
      alert('Camera access denied or not available')
    }
  }

  const captureFrame = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return null
    const w = video.videoWidth || 640
    const h = video.videoHeight || 480
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, w, h)
    // overlay text on snapshot as well
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, h - 80, w, 80)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 24px Inter, sans-serif'
    ctx.fillText(`Farmer: ${farmerName || ''}`.trim(), 16, h - 48)
    ctx.fillText(`Vehicle: ${vehicleNumber || ''}`.trim(), 16, h - 16)
    return canvas.toDataURL('image/jpeg', 0.8)
  }

  return (
    <div className="relative w-full max-w-3xl aspect-video bg-black rounded-lg overflow-hidden border border-gray-700">
      <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
      {/* Overlay */}
      <div className="absolute inset-0 pointer-events-none flex items-end">
        <div className="w-full p-4 bg-gradient-to-t from-black/70 to-transparent text-white">
          <div className="text-lg font-semibold">{farmerName || '—'}</div>
          <div className="text-sm opacity-90">{vehicleNumber || '—'}</div>
        </div>
      </div>
      <div className="absolute top-3 left-3 flex gap-2">
        <button onClick={startCamera} className="pointer-events-auto bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-md text-sm font-medium">Start Camera</button>
      </div>
      <canvas ref={canvasRef} className="hidden" />

      {/* expose capture via property pattern */}
      <input type="hidden" value="" onClick={() => {}} data-capture-fn={captureFrame} />
    </div>
  )
}

function App() {
  const [tab, setTab] = useState('weigh')
  const [farmerName, setFarmerName] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [gross, setGross] = useState('')
  const [tare, setTare] = useState('')
  const [pending, setPending] = useState([])

  const videoCompRef = useRef(null)

  useEffect(() => {
    // setup real-time subscription for pending tare
    const channel = supabase.channel('realtime:weighment_transactions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weighment_transactions' }, payload => {
        loadPending()
      })
      .subscribe()
    loadPending()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const loadPending = async () => {
    const { data, error } = await supabase
      .from('weighment_transactions')
      .select('id, created_at, farmer_id, vehicle_id, status, gross_weight')
      .eq('status', 'pending_tare')
      .order('created_at', { ascending: false })
    if (!error) setPending(data || [])
  }

  const saveGross = async () => {
    if (!farmerName || !vehicle || !gross) {
      alert('Fill farmer, vehicle and gross weight')
      return
    }

    // capture snapshot
    const captureEl = document.querySelector('[data-capture-fn]')
    const captureFn = captureEl && captureEl.getAttribute('data-capture-fn')
    let snapshotDataUrl = null
    try {
      // we cannot call function from attribute; instead re-calc below
      const video = document.querySelector('video')
      const canvas = document.createElement('canvas')
      const w = video?.videoWidth || 640
      const h = video?.videoHeight || 480
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      if (video) ctx.drawImage(video, 0, 0, w, h)
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(0, h - 80, w, 80)
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 24px Inter, sans-serif'
      ctx.fillText(`Farmer: ${farmerName}`.trim(), 16, h - 48)
      ctx.fillText(`Vehicle: ${vehicle}`.trim(), 16, h - 16)
      snapshotDataUrl = canvas.toDataURL('image/jpeg', 0.8)
    } catch (e) {}

    // Upload snapshot to storage
    let snapshot_url = null
    if (snapshotDataUrl) {
      const fileName = `snapshots/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
      const blob = await (await fetch(snapshotDataUrl)).blob()
      const { data: uploadData, error: uploadError } = await supabase.storage.from('weighment').upload(fileName, blob, { contentType: 'image/jpeg', upsert: true })
      if (!uploadError) {
        const { data: pub } = supabase.storage.from('weighment').getPublicUrl(fileName)
        snapshot_url = pub?.publicUrl || null
      }
    }

    // find or create farmer & vehicle minimal for demo
    let farmer_id = null
    {
      const { data } = await supabase.from('farmers_traders').select('id').eq('name', farmerName).maybeSingle()
      if (data?.id) farmer_id = data.id
      else {
        const { data: created } = await supabase.from('farmers_traders').insert({ name: farmerName }).select('id').single()
        farmer_id = created.id
      }
    }
    let vehicle_id = null
    {
      const { data } = await supabase.from('vehicles').select('id').eq('number_plate', vehicle).maybeSingle()
      if (data?.id) vehicle_id = data.id
      else {
        const { data: created } = await supabase.from('vehicles').insert({ number_plate: vehicle, farmer_id }).select('id').single()
        vehicle_id = created.id
      }
    }

    const { error } = await supabase.from('weighment_transactions').insert({
      farmer_id,
      vehicle_id,
      gross_weight: Number(gross),
      gross_datetime: new Date().toISOString(),
      status: 'pending_tare',
      weighment_snapshot_url: snapshot_url
    })
    if (error) alert('Error saving: ' + error.message)
    else {
      setGross('')
      loadPending()
      alert('Saved gross weight')
    }
  }

  const saveTare = async (txnId) => {
    if (!tare) { alert('Enter tare weight'); return }
    const { data: txn } = await supabase.from('weighment_transactions').select('gross_weight').eq('id', txnId).single()
    const net = Number(txn.gross_weight) - Number(tare)
    const { error } = await supabase.from('weighment_transactions').update({
      tare_weight: Number(tare),
      tare_datetime: new Date().toISOString(),
      net_weight: net,
      status: 'completed'
    }).eq('id', txnId)
    if (error) alert('Error updating tare: ' + error.message)
    else { setTare(''); loadPending(); alert('Completed transaction') }
  }

  return (
    <div className="min-h-screen bg-neutral-900 text-white">
      <header className="border-b border-neutral-800 px-6 py-4 flex items-center justify-between">
        <div className="text-xl font-bold tracking-tight">Ginning Mill Weighment</div>
        <nav className="flex gap-2">
          {['weigh','pending'].map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab===t?'bg-emerald-600':'bg-neutral-800 hover:bg-neutral-700'}`}>{t==='weigh'?'Weighbridge':'Pending Tare'}</button>
          ))}
        </nav>
      </header>

      <main className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {tab === 'weigh' && (
          <>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-neutral-300 mb-1">Farmer/Trader Name</label>
                <input value={farmerName} onChange={(e)=>setFarmerName(e.target.value)} className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 outline-none focus:ring-2 focus:ring-emerald-600" placeholder="Search or type name" />
              </div>
              <div>
                <label className="block text-sm text-neutral-300 mb-1">Vehicle Number Plate</label>
                <input value={vehicle} onChange={(e)=>setVehicle(e.target.value)} className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2" placeholder="e.g. GJ 01 AB 1234" />
              </div>
              <VideoOverlay farmerName={farmerName} vehicleNumber={vehicle} ref={videoCompRef} />
              <div>
                <label className="block text-sm text-neutral-300 mb-1">Gross Weight</label>
                <input type="number" step="0.01" value={gross} onChange={(e)=>setGross(e.target.value)} className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2" placeholder="Enter from scale" />
              </div>
              <div className="flex justify-end">
                <button onClick={saveGross} className="bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-md font-semibold">Save Weight</button>
              </div>
            </div>

            <div>
              <h3 className="text-lg font-semibold mb-3">Pending Tare</h3>
              <div className="space-y-3">
                {pending.length === 0 && <div className="text-neutral-400">No pending transactions</div>}
                {pending.map(txn => (
                  <div key={txn.id} className="bg-neutral-800 border border-neutral-700 rounded-md p-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium">{txn.vehicle_id}</div>
                      <div className="text-xs text-neutral-400">Gross: {txn.gross_weight}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input type="number" step="0.01" placeholder="Tare" className="bg-neutral-900 border border-neutral-700 rounded-md px-2 py-1 w-28" value={tare} onChange={(e)=>setTare(e.target.value)} />
                      <button onClick={()=>saveTare(txn.id)} className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-md text-sm">Save</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === 'pending' && (
          <div className="lg:col-span-2">
            <h3 className="text-lg font-semibold mb-3">Pending Tare Transactions</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {pending.map(txn => (
                <div key={txn.id} className="bg-neutral-800 border border-neutral-700 rounded-md p-3">
                  <div className="text-sm text-neutral-400 mb-2">ID: {txn.id}</div>
                  <div className="font-medium mb-2">Gross: {txn.gross_weight}</div>
                  <div className="flex gap-2">
                    <input type="number" step="0.01" placeholder="Tare" className="bg-neutral-900 border border-neutral-700 rounded-md px-2 py-1 w-28" value={tare} onChange={(e)=>setTare(e.target.value)} />
                    <button onClick={()=>saveTare(txn.id)} className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-md text-sm">Save</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
