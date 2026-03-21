class RoomChannel < ApplicationCable::Channel
  def subscribed
    @room_id = params[:room_id]
    @username = params[:username]

    stream_from "room_#{@room_id}"

    # Tell this subscriber who they are
    transmit({ type: "connection_ready", peer_id: current_user_id })

    # Get existing users BEFORE adding the new user
    existing_users = RoomStore.users_in(@room_id)

    # Add new user to the store
    RoomStore.join(@room_id, current_user_id, @username)

    # Tell the NEW user about everyone already in the room
    # so they can initiate WebRTC offers to existing peers
    transmit({ type: "existing_users", users: existing_users })

    # Broadcast to everyone else that a new peer joined
    ActionCable.server.broadcast("room_#{@room_id}", {
      type: "peer_joined",
      peer_id: current_user_id,
      username: @username
    })
  end

  def unsubscribed
    return unless @room_id

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
