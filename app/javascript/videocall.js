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
  let channel = null

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
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
      
      // Add fake video track so screensharing can use replaceTrack without renegotiation
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 640; canvas.height = 480
        canvas.getContext('2d').fillRect(0, 0, 640, 480)
        const fakeStream = canvas.captureStream ? canvas.captureStream() : null
        if (fakeStream) {
          const fakeVideo = fakeStream.getVideoTracks()[0]
          fakeVideo.enabled = false
          fakeVideo.canvas = canvas // Mark as fake track
          localStream.addTrack(fakeVideo)
        }
      } catch (e) {
        console.warn("Could not create fake video track", e)
      }
      
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
          // If message is from self (ActionCable bounces back unless handled), ignore.
          // Wait, ActionCable `from` is attached by the server. 
          // Server sets `data["from"] = current_user_id` in RoomChannel#receive.
          // Wait, server broadcasted `peer_joined` with `peer_id`.
          
          if (data.type === 'peer_joined') {
            if (data.peer_id === undefined) return
            // Save our own ID if this is us joining, wait we don't know who we are.
            // Let's use username for identifying for simplicity in this demo mesh.
            if (data.username !== username) handlePeerJoined(data.username)
          } else if (data.type === 'peer_left') {
            if (data.username !== username) handlePeerLeft(data.username)
          } else if (data.type === 'offer') {
            if (data.to === username) handleOffer(data)
          } else if (data.type === 'answer') {
            if (data.to === username) handleAnswer(data)
          } else if (data.type === 'ice_candidate') {
            if (data.to === username) handleIceCandidate(data)
          } else if (data.type === 'chat') {
            if (data.username !== username) {
              addChatMessage(data.username, data.message)
            }
          }
        }
      }
    )
  }

  function createPeerConnection(peerUsername) {
    const pc = new RTCPeerConnection(ICE_SERVERS)
    peers[peerUsername] = pc

    pc.onicecandidate = event => {
      if (event.candidate) {
        channel.send({ type: 'ice_candidate', to: peerUsername, candidate: event.candidate, from: username })
      }
    }

    pc.ontrack = event => {
      addVideoStream(peerUsername, event.streams[0], peerUsername, false)
    }

    const currentStream = isScreenSharing && screenStream ? screenStream : localStream
    currentStream.getTracks().forEach(track => pc.addTrack(track, currentStream))

    return pc
  }

  function handlePeerJoined(peerUsername) {
    // We initiate connection to the new peer
    const pc = createPeerConnection(peerUsername)
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        channel.send({ type: 'offer', to: peerUsername, offer: pc.localDescription, from: username })
      })
  }

  function handleOffer(data) {
    const peerUsername = data.from
    const pc = createPeerConnection(peerUsername)
    
    pc.setRemoteDescription(new RTCSessionDescription(data.offer))
      .then(() => pc.createAnswer())
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        channel.send({ type: 'answer', to: peerUsername, answer: pc.localDescription, from: username })
      })
  }

  function handleAnswer(data) {
    const pc = peers[data.from]
    if (pc) {
      pc.setRemoteDescription(new RTCSessionDescription(data.answer))
    }
  }

  function handleIceCandidate(data) {
    const pc = peers[data.from]
    if (pc && data.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(data.candidate))
    }
  }

  function handlePeerLeft(peerUsername) {
    if (peers[peerUsername]) {
      peers[peerUsername].close()
      delete peers[peerUsername]
    }
    const tile = document.getElementById(`video-${peerUsername}`)
    if (tile) tile.remove()
    updateGridLayout()
  }

  function addVideoStream(id, stream, name, isLocal) {
    let videoDiv = document.getElementById(`video-${id}`)
    if (!videoDiv) {
      videoDiv = document.createElement('div')
      videoDiv.id = `video-${id}`
      videoDiv.className = 'video-tile'
      videoGrid.appendChild(videoDiv)
    }

    // Replace contents safely
    videoDiv.innerHTML = `
      <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
      <div class="user-label">${name} ${isLocal ? '(You)' : ''}</div>
    `
    const videoObj = videoDiv.querySelector('video')
    videoObj.srcObject = stream

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
        // If the track is our fake canvas track, we can't toggle real camera
        const videoTrack = localStream.getVideoTracks()[0]
        if (videoTrack && videoTrack.canvas) { // canvas property exists only on our fake track
          alert("Camera is not available")
          return
        }
        if (videoTrack && !isScreenSharing) {
          videoTrack.enabled = !videoTrack.enabled
          toggleCam.classList.toggle('active', videoTrack.enabled)
        }
      })
    }

    if (toggleScreen) {
      toggleScreen.addEventListener('click', async () => {
        if (!isScreenSharing) {
          try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true })
            isScreenSharing = true
            toggleScreen.classList.add('active')

            const screenTrack = screenStream.getVideoTracks()[0]
            
            Object.values(peers).forEach(pc => {
              const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
              if (sender) sender.replaceTrack(screenTrack)
            })

            const localVideo = document.querySelector('#video-local video')
            if (localVideo) localVideo.srcObject = screenStream

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
      
      const localVideoTrack = localStream.getVideoTracks()[0]
      Object.values(peers).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
            if (sender && localVideoTrack) sender.replaceTrack(localVideoTrack)
      })

      const localVideo = document.querySelector('#video-local video')
      if (localVideo) localVideo.srcObject = localStream
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
