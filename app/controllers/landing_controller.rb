class LandingController < ApplicationController
  def index
    redirect_to rooms_path if session[:username].present?
  end
end
