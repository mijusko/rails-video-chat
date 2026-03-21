class RoomChannel < ApplicationCable::Channel
  def subscribed
    @room_id = params[:room_id]
    @username = params[:username]
    
    stream_from "room_#{@room_id}"
    
    # Send current_user_id to the subscriber so they know who they are
    transmit({ type: "connection_ready", peer_id: current_user_id })
    
    RoomStore.join(@room_id, current_user_id, @username)
    
    # Broadcast to others that a new peer joined, and send the current list of users to the new peer
    ActionCable.server.broadcast("room_#{@room_id}", {
      type: "peer_joined",
      peer_id: current_user_id,
      username: @username,
      users: RoomStore.users_in(@room_id)
    })
  end

  def unsubscribed
    RoomStore.leave(@room_id, current_user_id)
    
    ActionCable.server.broadcast("room_#{@room_id}", {
      type: "peer_left",
      peer_id: current_user_id
    })
  end

  # Relay WebRTC signaling messages and chat messages
  def receive(data)
    data["from_id"] = current_user_id
    ActionCable.server.broadcast("room_#{@room_id}", data)
  end
end
