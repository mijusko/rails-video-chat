class RoomsController < ApplicationController
  before_action :require_username

  def index
  end

  def show
    @room_id = params[:id]
    @username = session[:username]
  end

  private

  def require_username
    redirect_to root_path unless session[:username].present?
  end
end
