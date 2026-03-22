import * as ActionCable from "@rails/actioncable"

let currentChannel = null
let currentStream = null

function cleanup() {
  if (currentChannel) {
    currentChannel.unsubscribe()
    currentChannel = null
  }
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop())
    currentStream = null
  }
}

document.addEventListener("turbo:before-cache", cleanup)
document.addEventListener("turbo:load", () => {
  const layoutObj = document.querySelector('.room-layout')
  if (!layoutObj) return

  // Cleanup any previous session just in case
  cleanup()

  const cable = ActionCable.createConsumer()
  const roomId = layoutObj.dataset.roomId
  const username = layoutObj.dataset.username

  let localStream = null
  let screenStream = null
  let isScreenSharing = false
  let peers = {}
  let peerNames = {}
  let channel = null
  let myPeerId = null

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Free public TURN servers to handle strict NATs (different networks/4G)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  }

  const videoGrid = document.getElementById('video-grid')
  const chatMessages = document.getElementById('chat-messages')
  const chatInput = document.getElementById('chat-input')
  const sendBtn = document.getElementById('send-btn')

  // --- Initialize Local Media & Connections ---
  async function initializeApp() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      currentStream = localStream // Update global ref for cleanup
    } catch (err) {
      console.warn("Media access denied or not available. Running in chat/screen-share mode.", err)
      localStream = new MediaStream()
      

      // Update UI buttons to show disabled initially
      setTimeout(() => {
        document.getElementById('toggle-mic').classList.remove('active')
        document.getElementById('toggle-cam').classList.remove('active')
      }, 100)
    }
    
    addVideoStream('local', localStream, username, true)
    setupActionCable()
    setupControls()
  }

  initializeApp()

  function setupActionCable() {
    channel = cable.subscriptions.create(
      { channel: "RoomChannel", room_id: roomId, username: username }, 
      {
        connected() { 
          console.log("Connected to Room", roomId)
          currentChannel = channel // Update global ref for cleanup
        },
        received(data) {
          if (data.type === 'connection_ready') {
            myPeerId = data.peer_id
            console.log("My peer ID is:", myPeerId)
          } else if (data.type === 'existing_users') {
            // Connect to users who were already in the room before we joined
            (data.users || []).forEach(user => {
              if (user.id && user.id !== myPeerId) {
                peerNames[user.id] = user.username
                handlePeerJoined(user.id, user.username)
              }
            })
          } else if (data.type === 'peer_joined') {
            if (!data.peer_id || data.peer_id === myPeerId) return
            peerNames[data.peer_id] = data.username
            addChatMessage('System', `${data.username} joined the room`)
          } else if (data.type === 'peer_left') {
            if (!data.peer_id || data.peer_id === myPeerId) return
            if (peerNames[data.peer_id]) addChatMessage('System', `${peerNames[data.peer_id]} left the room`)
            handlePeerLeft(data.peer_id)
          } else if (data.type === 'offer') {
            if (data.to === myPeerId) handleOffer(data)
          } else if (data.type === 'answer') {
            if (data.to === myPeerId) handleAnswer(data)
          } else if (data.type === 'ice_candidate') {
            if (data.to === myPeerId) handleIceCandidate(data)
          } else if (data.type === 'chat') {
            if (data.from_id !== myPeerId) {
              addChatMessage(data.username, data.message)
            }
          }
        }
      }
    )
  }

  function createPeerConnection(peerId, peerUsername) {
    const pc = new RTCPeerConnection(ICE_SERVERS)
    pc.iceQueue = []
    peers[peerId] = pc

    pc.onicecandidate = event => {
      if (event.candidate) {
        channel.send({ type: 'ice_candidate', to: peerId, candidate: event.candidate, from_id: myPeerId })
      }
    }

    pc.ontrack = event => {
      addVideoStream(peerId, event.streams[0], peerUsername, false)
    }

    const currentStream = isScreenSharing && screenStream ? screenStream : localStream
    let hasAudio = false
    let hasVideo = false
    currentStream.getTracks().forEach(track => {
      pc.addTrack(track, currentStream)
      if (track.kind === 'audio') hasAudio = true
      if (track.kind === 'video') hasVideo = true
    })

    // Force negotiation of audio/video channels even if we don't have local tracks.
    // This allows us to RECEIVE them and SEND them later dynamically (via screen share).
    if (!hasAudio) pc.addTransceiver('audio', { direction: 'sendrecv' })
    if (!hasVideo) pc.addTransceiver('video', { direction: 'sendrecv' })

    return pc
  }

  function handlePeerJoined(peerId, peerUsername) {
    // We initiate connection to the new peer
    const pc = createPeerConnection(peerId, peerUsername)
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        channel.send({ type: 'offer', to: peerId, offer: pc.localDescription, from_id: myPeerId, from_username: username })
      })
  }

  function handleOffer(data) {
    const peerId = data.from_id
    const peerUsername = data.from_username
    peerNames[peerId] = peerUsername
    
    const pc = createPeerConnection(peerId, peerUsername)
    
    pc.setRemoteDescription(new RTCSessionDescription(data.offer))
      .then(() => {
        processIceQueue(pc)
        return pc.createAnswer()
      })
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        channel.send({ type: 'answer', to: peerId, answer: pc.localDescription, from_id: myPeerId })
      })
      .catch(e => console.error("Error handling offer:", e))
  }

  function handleAnswer(data) {
    const pc = peers[data.from_id]
    if (pc) {
      pc.setRemoteDescription(new RTCSessionDescription(data.answer))
        .then(() => processIceQueue(pc))
        .catch(e => console.error("Error setting answer:", e))
    }
  }

  function handleIceCandidate(data) {
    const pc = peers[data.from_id]
    if (pc && data.candidate) {
      if (pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(e => console.error("Error adding ice candidate:", e))
      } else {
        pc.iceQueue.push(data.candidate)
      }
    }
  }

  function processIceQueue(pc) {
    if (pc.iceQueue && pc.iceQueue.length > 0) {
      pc.iceQueue.forEach(candidate => {
        pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding queued ice candidate:", e))
      })
      pc.iceQueue = []
    }
  }

  function handlePeerLeft(peerId) {
    if (peers[peerId]) {
      peers[peerId].close()
      delete peers[peerId]
    }
    if (peerNames[peerId]) delete peerNames[peerId]
    const tile = document.getElementById(`video-${peerId}`)
    if (tile) tile.remove()
    updateGridLayout()
  }

  function addVideoStream(id, stream, name, isLocal) {
    let videoDiv = document.getElementById(`video-${id}`)
    
    if (videoDiv) {
      // Tile already exists, ensure stream is attached if it changed
      const videoObj = videoDiv.querySelector('video')
      if (videoObj.srcObject !== stream) {
        videoObj.srcObject = stream
        videoObj.play().catch(e => console.warn("Auto-play prevented", e))
      }
      return
    }

    videoDiv = document.createElement('div')
    videoDiv.id = `video-${id}`
    videoDiv.className = 'video-tile'
    videoGrid.appendChild(videoDiv)

    videoDiv.innerHTML = `
      <div class="video-placeholder">
        <svg viewBox="0 0 24 24" fill="none" class="user-avatar" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      </div>
      <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
      <div class="user-label">${name} ${isLocal ? '(You)' : ''}</div>
    `
    const videoObj = videoDiv.querySelector('video')
    videoObj.srcObject = stream

    videoObj.play().catch(e => console.warn("Auto-play prevented", e))

    const checkTracks = () => {
      const videoTrack = stream.getVideoTracks()[0]
      const hasActiveVideo = videoTrack && !videoTrack.muted && videoTrack.enabled && videoTrack.readyState === 'live'
      videoObj.style.opacity = hasActiveVideo ? '1' : '0'
    }
    
    stream.addEventListener('addtrack', checkTracks)
    stream.addEventListener('removetrack', checkTracks)
    stream.getVideoTracks().forEach(t => {
      t.onunmute = checkTracks
      t.onmute = checkTracks
      t.onended = checkTracks
    })
    
    setTimeout(checkTracks, 500)

    updateGridLayout()
  }

  function updateGridLayout() {
    const tiles = videoGrid.children.length
    if (tiles === 1) videoGrid.className = 'video-grid grid-1'
    else if (tiles === 2) videoGrid.className = 'video-grid grid-2'
    else if (tiles <= 4) videoGrid.className = 'video-grid grid-4'
    else videoGrid.className = 'video-grid grid-many'
  }

  // --- UI Controls ---
  function setupControls() {
    const toggleMic = document.getElementById('toggle-mic')
    const toggleCam = document.getElementById('toggle-cam')
    const toggleScreen = document.getElementById('toggle-screen')
    const toggleChat = document.getElementById('toggle-chat')
    const leaveBtn = document.getElementById('leave-btn')
    const copyBtn = document.getElementById('copy-room-btn')
    const chatPanelObj = document.getElementById('chat-panel')
    const closeChatBtn = document.getElementById('close-chat-btn')

    if (toggleMic) {
      toggleMic.addEventListener('click', () => {
        const audioTrack = localStream.getAudioTracks()[0]
        if (audioTrack) {
          audioTrack.enabled = !audioTrack.enabled
          toggleMic.classList.toggle('active', audioTrack.enabled)
        } else {
          alert("Microphone is not available")
        }
      })
    }

    if (toggleCam) {
      toggleCam.addEventListener('click', () => {
        const videoTrack = localStream.getVideoTracks()[0]
        if (!videoTrack && !isScreenSharing) {
          alert("Camera is not available")
          return
        }
        if (videoTrack && !isScreenSharing) {
          videoTrack.enabled = !videoTrack.enabled
          toggleCam.classList.toggle('active', videoTrack.enabled)
          
          const localVideo = document.querySelector('#video-local video')
          if (localVideo) localVideo.style.opacity = videoTrack.enabled ? '1' : '0'
        }
      })
    }

    if (toggleScreen) {
      toggleScreen.addEventListener('click', async () => {
        if (!isScreenSharing) {
          try {
            if (navigator.mediaDevices.getDisplayMedia) {
              screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true })
            } else {
              // Fallback for mobile (like iOS Safari) that completely lack getDisplayMedia
              // Use rear camera as an alternative way to "share" context
              try {
                screenStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: "environment" } } })
              } catch (e) {
                screenStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
              }
            }

            if (!screenStream) throw new Error("Could not acquire screen or rear camera")

            isScreenSharing = true
            toggleScreen.classList.add('active')

            const screenTrack = screenStream.getVideoTracks()[0]
            
            Object.values(peers).forEach(pc => {
              const transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === 'video')
              if (transceiver && transceiver.sender) {
                transceiver.sender.replaceTrack(screenTrack)
              }
            })

            const localVideo = document.querySelector('#video-local video')
            if (localVideo) {
              localVideo.srcObject = screenStream
              localVideo.style.opacity = '1'
            }

            screenTrack.onended = stopScreenShare
          } catch (e) { console.error("Screen share failed", e) }
        } else {
          stopScreenShare()
        }
      })
    }

    function stopScreenShare() {
      isScreenSharing = false
      if (toggleScreen) toggleScreen.classList.remove('active')
      if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop())
        screenStream = null
      }
      
      const localVideoTrack = localStream.getVideoTracks()[0] || null
      Object.values(peers).forEach(pc => {
        const transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === 'video')
        if (transceiver && transceiver.sender) {
             transceiver.sender.replaceTrack(localVideoTrack)
        }
      })

      const localVideo = document.querySelector('#video-local video')
      if (localVideo) {
        localVideo.srcObject = localStream
        localVideo.style.opacity = localVideoTrack && localVideoTrack.enabled ? '1' : '0'
      }
    }

    if (leaveBtn) {
      leaveBtn.addEventListener('click', () => {
        cleanup()
        window.location.href = '/rooms' // Leave room
      })
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(roomId).then(() => {
          const tooltip = document.getElementById('copy-tooltip')
          if (tooltip) {
            tooltip.style.opacity = '1'
            setTimeout(() => tooltip.style.opacity = '0', 2000)
          }
        })
      })
    }

    if (toggleChat && chatPanelObj) {
      toggleChat.addEventListener('click', () => chatPanelObj.classList.add('open'))
    }
    
    if (closeChatBtn && chatPanelObj) {
      closeChatBtn.addEventListener('click', () => chatPanelObj.classList.remove('open'))
    }

    // Chat Send
    function sendChat() {
      if (!chatInput) return
      const msg = chatInput.value.trim()
      if (msg && channel) {
        addChatMessage(username, msg) // Optimistic UI update
        // We do not want to receive our own message back and duplicate it
        channel.send({ type: 'chat', username: username, message: msg })
        chatInput.value = ''
      }
    }

    if (sendBtn) sendBtn.addEventListener('click', sendChat)
    if (chatInput) {
      chatInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') sendChat()
      })
    }
  }

  function addChatMessage(user, msg) {
    const div = document.createElement('div')
    div.className = user === username ? 'msg self' : 'msg other'
    div.innerHTML = `<strong>${user}:</strong> ${msg}`
    chatMessages.appendChild(div)
    chatMessages.scrollTop = chatMessages.scrollHeight
  }
})
