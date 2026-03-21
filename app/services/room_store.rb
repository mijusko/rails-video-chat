module RoomStore
  ROOMS = Concurrent::Hash.new { |h, k| h[k] = Concurrent::Array.new }

  def self.join(room_id, user_id, username)
    ROOMS[room_id] << { id: user_id, username: username }
  end

  def self.leave(room_id, user_id)
    ROOMS[room_id].delete_if { |u| u[:id] == user_id }
    ROOMS.delete(room_id) if ROOMS[room_id].empty?
  end

  def self.users_in(room_id)
    ROOMS[room_id].dup
  end

  def self.room_exists?(room_id)
    ROOMS.key?(room_id)
  end
end
