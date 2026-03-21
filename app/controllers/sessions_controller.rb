class SessionsController < ApplicationController
  def create
    username = params[:username].to_s.strip
    if username.present?
      session[:username] = username
      redirect_to rooms_path
    else
      redirect_to root_path, alert: "Please enter a username"
    end
  end

  def destroy
    session.delete(:username)
    redirect_to root_path
  end
end
